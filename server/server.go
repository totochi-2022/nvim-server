package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"github.com/gorilla/websocket"
	"github.com/neovim/go-client/nvim"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed static/*
var staticFiles embed.FS

type ClientSession struct {
	nvim       *nvim.Nvim
	conn       *websocket.Conn
	address    string
	active     bool
	uiAttached bool
	// gorilla/websocket forbids concurrent writes to a single connection.
	// redraw notifications arrive on nvim's RPC goroutine while clipboard /
	// status messages are written from others, so serialize all writes.
	writeMu sync.Mutex
}

type Server struct {
	upgrader websocket.Upgrader
	clients  map[*websocket.Conn]*ClientSession
	mu       sync.RWMutex
}

func Serve(address string) error {
	ctx := &Server{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		clients: make(map[*websocket.Conn]*ClientSession),
	}

	staticFS, _ := fs.Sub(staticFiles, "static")
	http.Handle("/", http.FileServer(http.FS(staticFS)))

	http.HandleFunc("/ws", ctx.handleWebSocket)

	http.HandleFunc("/sessions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(listSessions())
	})

	// Serve a file from disk by absolute path, used by the built-in previewer
	// (preview.html fetches /file?path=...). Localhost-only personal tool.
	http.HandleFunc("/file", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		if p == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		http.ServeFile(w, r, p)
	})

	log.Printf("Server starting on %s", address)

	err := http.ListenAndServe(address, nil)
	if err != nil {
		return err
	}

	return nil
}

func (ctx *Server) listenToNeovimEvents(session *ClientSession) error {
	// Capture the connection once: a concurrent disconnect/reconnect can set
	// session.nvim to nil, and calling methods on a nil *Nvim segfaults and
	// takes the whole server down. Guard against that.
	nv := session.nvim
	if nv == nil {
		return nil
	}

	nv.RegisterHandler("redraw", func(updates ...[]any) {
		if !session.active {
			return
		}
		for _, update := range updates {
			message := map[string]any{
				"type": "redraw",
				"data": update,
			}
			ctx.sendToClient(session, message)
		}
	})

	if err := nv.Subscribe("redraw"); err != nil {
		return fmt.Errorf("failed to subscribe to redraw events: %w", err)
	}

	err := nv.Serve()

	log.Printf("Neovim session closed for client")

	session.active = false
	session.uiAttached = false // Reset UI state
	ctx.sendToClient(session, map[string]any{
		"type": "session_closed",
		"data": "Neovim session has been closed",
	})

	return err
}

func (ctx *Server) sendToClient(session *ClientSession, message map[string]any) {
	if !session.active && message["type"] != "session_closed" {
		return
	}

	session.writeMu.Lock()
	err := session.conn.WriteJSON(message)
	session.writeMu.Unlock()
	if err != nil {
		log.Printf("Write error to client: %v", err)
		session.active = false
		session.conn.Close()
	}
}

var sessionNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// sessionDir is where named Neovim instances keep their listen sockets so they
// can be discovered and listed by the connection screen.
func sessionDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "nvim-server")
}

// sessionSocket maps a user-supplied session name to a socket path in the
// session dir, sanitizing the name so it can't escape the directory.
func sessionSocket(name string) string {
	clean := sessionNameRe.ReplaceAllString(name, "-")
	clean = strings.Trim(clean, "-.")
	if clean == "" {
		clean = "nvim"
	}
	return filepath.Join(sessionDir(), clean+".sock")
}

type sessionInfo struct {
	Address string `json:"address"`
	Name    string `json:"name"`
	Label   string `json:"label"`
}

// listSessions enumerates live Neovim sockets in the session dir. It labels each
// with the instance's working directory and prunes sockets with no listener.
func listSessions() []sessionInfo {
	socks, _ := filepath.Glob(filepath.Join(sessionDir(), "*.sock"))
	out := []sessionInfo{}
	for _, sock := range socks {
		name := strings.TrimSuffix(filepath.Base(sock), ".sock")
		v, err := nvim.Dial(sock)
		if err != nil {
			// No listener: stale socket file, remove it.
			os.Remove(sock)
			continue
		}
		label := name
		var cwd string
		if err := v.Call("getcwd", &cwd); err == nil && cwd != "" {
			label = cwd
		}
		v.Close()
		out = append(out, sessionInfo{Address: sock, Name: name, Label: label})
	}
	return out
}

// spawnNeovim launches a detached headless Neovim listening on address when one
// isn't already there. TCP targets are restricted to loopback, and socket
// targets must live in the session dir, so a browser can't make the host start
// processes for arbitrary remote addresses or write sockets anywhere.
func spawnNeovim(address string) error {
	network := "unix"
	if strings.Contains(address, ":") {
		network = "tcp"
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return fmt.Errorf("invalid address %q: %w", address, err)
		}
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			return fmt.Errorf("refusing to start Neovim for non-local address %q", address)
		}
	} else {
		abs, err := filepath.Abs(address)
		if err != nil || filepath.Dir(abs) != sessionDir() {
			return fmt.Errorf("refusing to create a socket outside the session dir")
		}
		if err := os.MkdirAll(sessionDir(), 0o700); err != nil {
			return fmt.Errorf("failed to create session dir: %w", err)
		}
	}

	// Already listening? Nothing to do.
	if conn, err := net.DialTimeout(network, address, 200*time.Millisecond); err == nil {
		conn.Close()
		return nil
	}

	cmd := exec.Command("nvim", "--headless", "--listen", address)
	// Detach into its own session so it survives this server restarting/exiting,
	// and behaves like a normal interactive Neovim (quits on :q). Stdin is nil
	// (= /dev/null), which a headless instance tolerates without exiting.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start nvim: %w", err)
	}
	// Reap the process so it doesn't linger as a zombie after :q.
	go cmd.Wait()

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if conn, err := net.DialTimeout(network, address, 200*time.Millisecond); err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("nvim did not start listening on %s", address)
}

func (ctx *Server) handleClientMessage(session *ClientSession, msg map[string]any) {
	switch msg["type"] {
	case "connect":
		address, ok := msg["address"].(string)
		if !ok {
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": "Invalid server address",
			})
			return
		}

		if err := ctx.connectSessionToNeovim(session, address); err != nil {
			log.Printf("Failed to connect client to Neovim at %s: %v", address, err)
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": fmt.Sprintf("Failed to connect to Neovim: %v", err),
			})
			return
		}

		ctx.sendToClient(session, map[string]any{
			"type": "connected",
			"data": "Successfully connected to Neovim",
		})
	case "spawn":
		address, _ := msg["address"].(string)
		// A "name" starts a discoverable socket session in the session dir;
		// otherwise "address" (e.g. localhost:9000) is used directly.
		if name, ok := msg["name"].(string); ok && name != "" {
			address = sessionSocket(name)
		}
		if address == "" {
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": "Invalid server address",
			})
			return
		}

		if err := spawnNeovim(address); err != nil {
			log.Printf("Failed to spawn Neovim at %s: %v", address, err)
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": fmt.Sprintf("Failed to start Neovim: %v", err),
			})
			return
		}

		if err := ctx.connectSessionToNeovim(session, address); err != nil {
			log.Printf("Failed to connect after spawn at %s: %v", address, err)
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": fmt.Sprintf("Started Neovim but failed to connect: %v", err),
			})
			return
		}

		ctx.sendToClient(session, map[string]any{
			"type": "connected",
			"data": "Started and connected to Neovim",
		})
	case "clipboard_content":
		if !session.active || session.nvim == nil {
			return
		}

		err := session.nvim.SetVar("nvim_server_clipboard", msg["data"])
		if err != nil {
			log.Printf("Failed to set clipboard variable: %v", err)
		}
	default:
		if !session.active || session.nvim == nil {
			ctx.sendToClient(session, map[string]any{
				"type": "error",
				"data": "Not connected to Neovim",
			})
			return
		}

		ctx.handleNeovimCommand(session, msg)
	}
}

func (ctx *Server) handleNeovimCommand(session *ClientSession, msg map[string]any) {
	if !session.active || session.nvim == nil {
		ctx.sendToClient(session, map[string]any{
			"type": "error",
			"data": "Neovim session is no longer active",
		})
		return
	}

	switch msg["type"] {
	case "attach_ui":
		width := int(msg["width"].(float64))
		height := int(msg["height"].(float64))
		options := map[string]any{
			"ext_linegrid":  true,
			"ext_multigrid": false,
			"rgb":           true,
		}
		if err := session.nvim.AttachUI(width, height, options); err != nil {
			log.Printf("Error attaching UI: %v", err)
			session.uiAttached = false
			if strings.Contains(err.Error(), "session closed") {
				session.active = false
				ctx.sendToClient(session, map[string]any{
					"type": "session_closed",
					"data": "Neovim session has been closed",
				})
			}
		} else {
			session.uiAttached = true
		}
	case "input":
		input := msg["data"].(string)
		if _, err := session.nvim.Input(input); err != nil {
			log.Printf("Error sending input: %v", err)
			if strings.Contains(err.Error(), "session closed") {
				session.active = false
				ctx.sendToClient(session, map[string]any{
					"type": "session_closed",
					"data": "Neovim session has been closed",
				})
			}
		}
	case "command":
		cmd := msg["data"].(string)

		if strings.Contains(cmd, "nvim_ui_attach") {
			if err := session.nvim.AttachUI(80, 24, map[string]any{
				"ext_linegrid":  true,
				"ext_multigrid": false,
				"rgb":           true,
			}); err != nil {
				log.Printf("Error attaching UI: %v", err)
			}
		} else if after, ok := strings.CutPrefix(cmd, "lua "); ok {
			luaCode := after
			if err := session.nvim.ExecLua(luaCode, nil); err != nil {
				log.Printf("Error executing Lua: %v", err)
			}
		} else {
			if err := session.nvim.Command(cmd); err != nil {
				log.Printf("Error executing command: %v", err)
			}
		}
	case "resize":
		if !session.uiAttached {
			return
		}

		width := int(msg["width"].(float64))
		height := int(msg["height"].(float64))
		if err := session.nvim.TryResizeUI(width, height); err != nil {
			log.Printf("Error resizing UI: %v", err)
			if strings.Contains(err.Error(), "UI not attached") {
				session.uiAttached = false
			} else if strings.Contains(err.Error(), "session closed") {
				session.active = false
				session.uiAttached = false
				ctx.sendToClient(session, map[string]any{
					"type": "session_closed",
					"data": "Neovim session has been closed",
				})
			}
		}
	case "mouse":
		action := msg["action"].(string)
		button := int(msg["button"].(float64))
		row := int(msg["row"].(float64))
		col := int(msg["col"].(float64))

		var input string
		switch button {
		case 0:
			switch action {
			case "press":
				input = fmt.Sprintf("<LeftMouse><%d,%d>", col, row)
			case "drag":
				input = fmt.Sprintf("<LeftDrag><%d,%d>", col, row)
			default:
				input = fmt.Sprintf("<LeftRelease><%d,%d>", col, row)
			}
		case 2:
			switch action {
			case "press":
				input = fmt.Sprintf("<RightMouse><%d,%d>", col, row)
			case "drag":
				input = fmt.Sprintf("<RightDrag><%d,%d>", col, row)
			default:
				input = fmt.Sprintf("<RightRelease><%d,%d>", col, row)
			}
		}

		if input != "" {
			if _, err := session.nvim.Input(input); err != nil {
				log.Printf("Error sending mouse input: %v", err)
			}
		}
	case "scroll":
		direction := msg["direction"].(string)
		row := int(msg["row"].(float64))
		col := int(msg["col"].(float64))

		var input string
		if direction == "up" {
			input = fmt.Sprintf("<ScrollWheelUp><%d,%d>", col, row)
		} else {
			input = fmt.Sprintf("<ScrollWheelDown><%d,%d>", col, row)
		}

		if _, err := session.nvim.Input(input); err != nil {
			log.Printf("Error sending scroll input: %v", err)
		}

	}

}

func (ctx *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := ctx.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	session := &ClientSession{
		conn:   conn,
		active: false,
	}

	ctx.mu.Lock()
	ctx.clients[conn] = session
	ctx.mu.Unlock()

	defer func() {
		ctx.mu.Lock()
		if session.nvim != nil {
			ctx.restoreMarkdownPreview(session)
			ctx.restoreWebOpen(session)
			session.nvim.Close()
		}
		delete(ctx.clients, conn)
		ctx.mu.Unlock()
	}()

	session.writeMu.Lock()
	conn.WriteJSON(map[string]any{
		"type": "ready",
		"data": "WebSocket connected. Please provide Neovim server addresctx.",
	})
	session.writeMu.Unlock()

	// Keepalive: reap dead browser connections (closed tab / dropped network)
	// so their attached Neovim UI detaches promptly. With ext_multigrid:false
	// all UIs share ONE grid sized to the SMALLEST attached UI, so a lingering
	// zombie UI pins the grid tiny — a reconnect then starts in a small area and
	// even <C-l> (resize) can't grow it. Pinging lets a stale read time out.
	const (
		pongWait   = 60 * time.Second
		pingPeriod = 54 * time.Second // must be < pongWait
	)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				// WriteControl is safe to call concurrently with other writes
				// (gorilla guarantees this), so no writeMu needed here.
				if err := conn.WriteControl(
					websocket.PingMessage, nil, time.Now().Add(10*time.Second),
				); err != nil {
					return
				}
			}
		}
	}()

	for {
		var msg map[string]any
		err := conn.ReadJSON(&msg)
		if err != nil {
			log.Printf("Read error: %v", err)
			break
		}

		ctx.handleClientMessage(session, msg)
	}
}

func (ctx *Server) connectSessionToNeovim(session *ClientSession, address string) error {
	if session.nvim != nil {
		session.nvim.Close()
		session.nvim = nil
	}

	// Single-viewer policy: this server is driven by one client at a time, so a
	// reconnect to the same Neovim evicts any previous connection to it. Without
	// this, the old (usually already-dead) UI lingers and — since all UIs share
	// one grid sized to the smallest (ext_multigrid:false) — pins the grid tiny
	// until keepalive reaps it ~60s later. Closing it here detaches that UI at
	// once, so Neovim regrows the grid to this fresh UI immediately.
	ctx.mu.Lock()
	for _, other := range ctx.clients {
		if other != session && other.address == address && other.nvim != nil {
			log.Printf("Evicting previous connection to %s", address)
			other.nvim.Close() // detaches its UI; its read loop then cleans up
			other.nvim = nil
			other.active = false
		}
	}
	ctx.mu.Unlock()

	client, err := nvim.Dial(address)
	if err != nil {
		return fmt.Errorf("failed to dial %s: %w", address, err)
	}

	session.nvim = client
	session.address = address
	session.active = true
	log.Printf("Successfully connected client to neovim at %s", address)

	if err := ctx.setupClipboard(session); err != nil {
		log.Printf("Failed to setup clipboard: %v", err)
	}

	ctx.setupMarkdownPreview(session)
	ctx.setupWebOpen(session)

	go func() {
		if err := ctx.listenToNeovimEvents(session); err != nil {
			log.Printf("Error in Neovim event listener: %v", err)
		}
	}()

	return nil
}

// setupMarkdownPreview redirects markdown-preview.nvim's browser-open hook to
// the connected web client while this session is attached, so the preview shows
// in a pane instead of an external browser. The previous value is restored on
// disconnect (see handleWebSocket) so normal terminal/GUI use is unaffected.
func (ctx *Server) setupMarkdownPreview(session *ClientSession) {
	channelID := session.nvim.ChannelID()

	cfg := fmt.Sprintf(`
if vim.g.nvim_server_prev_mkdp_browserfunc == nil then
  vim.g.nvim_server_prev_mkdp_browserfunc = vim.g.mkdp_browserfunc or ''
end
vim.g.nvim_server_mkdp_channel = %d
vim.cmd([[
function! NvimServerOpenPreview(url) abort
  call rpcnotify(g:nvim_server_mkdp_channel, 'mkdp_open', a:url)
endfunction
]])
vim.g.mkdp_browserfunc = 'NvimServerOpenPreview'
return true
`, channelID)

	var ok bool
	if err := session.nvim.ExecLua(cfg, &ok); err != nil {
		log.Printf("Failed to setup markdown preview hook: %v", err)
		return
	}

	session.nvim.RegisterHandler("mkdp_open", func(url string) {
		ctx.sendToClient(session, map[string]any{
			"type":  "open_preview",
			"url":   url,
			"label": "Markdown Preview",
		})
	})
}

// restoreMarkdownPreview puts markdown-preview.nvim's hook back so that normal
// (non-web) usage opens an external browser again.
func (ctx *Server) restoreMarkdownPreview(session *ClientSession) {
	if session.nvim == nil {
		return
	}
	var ok bool
	_ = session.nvim.ExecLua(`
vim.g.mkdp_browserfunc = vim.g.nvim_server_prev_mkdp_browserfunc or ''
vim.g.nvim_server_prev_mkdp_browserfunc = nil
return true
`, &ok)
}

// setupWebOpen exposes this session's RPC channel as g:nvim_server_channel and
// forwards any 'web_open_url' notification to the client as a preview pane. This
// is a generic bridge: any tool (e.g. typst-preview) can route a URL to the
// browser pane by rpcnotify(g:nvim_server_channel, 'web_open_url', url) while a
// web client is attached, and fall back to a real browser otherwise.
func (ctx *Server) setupWebOpen(session *ClientSession) {
	if err := session.nvim.SetVar("nvim_server_channel", session.nvim.ChannelID()); err != nil {
		log.Printf("Failed to set nvim_server_channel: %v", err)
		return
	}
	session.nvim.RegisterHandler("web_open_url", func(url string, label string) {
		ctx.sendToClient(session, map[string]any{
			"type":  "open_preview",
			"url":   url,
			"label": label,
		})
	})
	// web_resize lets Neovim ask the browser to re-measure its viewport and
	// resend the grid size. Useful to recover when the UI attached with a tiny
	// grid (small viewport / font not yet measured at attach time). Bind it in
	// Neovim, e.g. to <C-l>: rpcnotify(g:nvim_server_channel, 'web_resize').
	session.nvim.RegisterHandler("web_resize", func() {
		ctx.sendToClient(session, map[string]any{
			"type": "recompute_size",
		})
	})
	// web_home asks the browser to return to the session selection screen
	// (connection form) without killing this Neovim instance. Bind it in
	// Neovim, e.g. rpcnotify(g:nvim_server_channel, 'web_home').
	session.nvim.RegisterHandler("web_home", func() {
		ctx.sendToClient(session, map[string]any{
			"type": "show_form",
		})
	})
	// web_preview_resize / _reset / _close: プレビューペインの幅調整・閉じる。
	// preview_pane.lua から rpcnotify(g:nvim_server_channel, ...) で呼ぶ。
	session.nvim.RegisterHandler("web_preview_resize", func(delta int) {
		ctx.sendToClient(session, map[string]any{
			"type":  "preview_resize",
			"delta": delta,
		})
	})
	// CSS のみ更新（reflow 保留, submode 連打用）
	session.nvim.RegisterHandler("web_preview_resize_css", func(delta int) {
		ctx.sendToClient(session, map[string]any{
			"type":  "preview_resize_css",
			"delta": delta,
		})
	})
	// 保留した幅変更を reflow に反映（submode 終了時）
	session.nvim.RegisterHandler("web_preview_commit", func() {
		ctx.sendToClient(session, map[string]any{"type": "preview_commit"})
	})
	session.nvim.RegisterHandler("web_preview_reset", func() {
		ctx.sendToClient(session, map[string]any{"type": "preview_reset"})
	})
	session.nvim.RegisterHandler("web_preview_close", func() {
		ctx.sendToClient(session, map[string]any{"type": "close_preview"})
	})
	// ペインを隠すが reflow は保留（submode 用、commit で反映）
	session.nvim.RegisterHandler("web_preview_close_css", func() {
		ctx.sendToClient(session, map[string]any{"type": "close_preview_css"})
	})
}

// restoreWebOpen clears the channel so tools fall back to a real browser once the
// web client disconnects.
func (ctx *Server) restoreWebOpen(session *ClientSession) {
	if session.nvim == nil {
		return
	}
	_ = session.nvim.SetVar("nvim_server_channel", 0)
}

func (ctx *Server) setupClipboard(session *ClientSession) error {
	channelID := session.nvim.ChannelID()

	clipboardConfig := fmt.Sprintf(`
vim.g.clipboard = {
  name = 'nvim-server',
  copy = {
    ['+'] = function(lines, regtype)
      local content = table.concat(lines, '\n')
      vim.rpcnotify(%d, 'clipboard_copy', content)
      return 0
    end,
    ['*'] = function(lines, regtype)
      local content = table.concat(lines, '\n')
      vim.rpcnotify(%d, 'clipboard_copy', content)
      return 0
    end,
  },
  paste = {
	['+'] = function()
	  vim.g.nvim_server_clipboard = nil
	  vim.rpcnotify(%d, 'clipboard_paste')
	  
	  local timeout = 300
	  while timeout > 0 and vim.g.nvim_server_clipboard == nil do
		vim.wait(10)
		timeout = timeout - 1
	  end
	  
	  local content = vim.g.nvim_server_clipboard
	  if content == nil or content == '' then
		print('Clipboard paste timeout or empty')
		return {''}
	  end
	  
	  return vim.split(content, '\n', { plain = true })
	end,
	['*'] = function()
	  vim.g.nvim_server_clipboard = nil
	  vim.rpcnotify(%d, 'clipboard_paste')
	  
	  local timeout = 300
	  while timeout > 0 and vim.g.nvim_server_clipboard == nil do
		vim.wait(10)
		timeout = timeout - 1
	  end
	  
	  local content = vim.g.nvim_server_clipboard
	  if content == nil or content == '' then
		return {''}
	  end
	  
	  return vim.split(content, '\n', { plain = true })
	end,
  }
}
return true
`, channelID, channelID, channelID, channelID)

	var result bool
	if err := session.nvim.ExecLua(clipboardConfig, &result); err != nil {
		return err
	}

	reloadConfig := `
vim.g.loaded_clipboard_provider = nil
vim.cmd('runtime autoload/provider/clipboard.vim')
vim.opt.clipboard = 'unnamedplus'
return true
`

	if err := session.nvim.ExecLua(reloadConfig, &result); err != nil {
		return err
	}

	// Register message handlers
	session.nvim.RegisterHandler("clipboard_copy", func(content string) {
		ctx.sendToClient(session, map[string]any{
			"type": "clipboard_set",
			"data": content,
		})
	})

	session.nvim.RegisterHandler("clipboard_paste", func() {
		ctx.sendToClient(session, map[string]any{
			"type": "clipboard_get",
		})
	})

	return nil
}
