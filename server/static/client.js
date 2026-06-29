class NeovimClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.renderer = null;
        this.clipboardEnabled = navigator.clipboard &&
            globalThis.isSecureContext;
        this.lastClipboardContent = "";
        this.previewActive = false;
        this.previewWidthPct = 50; // プレビューペイン幅(vw%)。ss モードの ]/[ で調整
        try {
            const v = parseInt(localStorage.getItem("previewWidthPct"), 10);
            if (v >= 20 && v <= 80) this.previewWidthPct = v;
        } catch (e) { /* localStorage 不可は無視 */ }
        this.requestClipboardPermission();
    }

    initRenderer() {
        const canvas = document.getElementById("terminal");
        if (canvas) {
            this.renderer = new NeovimRenderer(canvas);
        }
    }

    showConnectionForm() {
        const connectionForm = document.getElementById("connection-form");
        const terminal = document.getElementById("terminal");

        if (connectionForm) {
            connectionForm.style.display = "block";
            connectionForm.style.opacity = "1";
        }

        if (terminal) {
            terminal.classList.remove("connected");
            terminal.style.display = "none";
        }

        if (this.renderer) {
            this.renderer = null;
        }

        this.closePreview();
        this.refreshSessions();

        const addressInput = document.getElementById("nvim-address");
        if (addressInput) {
            addressInput.focus();
        }
    }

    updateTitle(serverAddress = null, status = null) {
        let title = "Neovim Server";

        if (serverAddress) {
            title += ` - ${serverAddress}`;
        }

        if (status) {
            title += ` (${status})`;
        }

        document.title = title;
    }

    updateFavicon(status = "default") {
        let link = document.querySelector("link[rel*='icon']");
        if (!link) {
            link = document.createElement("link");
            link.type = "image/svg+xml";
            link.rel = "shortcut icon";
            document.head.appendChild(link);
        }

        switch (status) {
            case "error": {
                link.href = "neovim-inactive.svg";
                break;
            }
            case "connecting": {
                link.href = "neovim-inactive.svg";
                break;
            }
            default: {
                link.href = "neovim.svg";
                break;
            }
        }
    }

    handleMessage(msg) {
        switch (msg.type) {
            case "ready": {
                this.updateStatus("Ready to connect to Neovim");
                this.updateTitle();
                this.updateFavicon("default");
                break;
            }
            case "connected": {
                this.connected = true;
                this.updateStatus(
                    "Connected to Neovim successfully! Initializing UI...",
                );

                const addressInput = document.getElementById("nvim-address");
                if (addressInput && addressInput.value) {
                    this.updateTitle(addressInput.value);
                    this.updateFavicon("connected");
                }

                this.hideConnectionForm();
                this.initRenderer();

                setTimeout(() => {
                    this.resizeTerminalToFullViewport();
                    this.attachUI();
                }, 100);

                this.sendCommand("set mouse=a");

                this.focusInput();
                break;
            }
            case "session_closed": {
                this.connected = false;
                this.updateStatus("Neovim session closed - " + msg.data);
                this.updateTitle();
                this.updateFavicon("error");
                this.showConnectionForm();
                break;
            }
            case "error": {
                console.error("Error:", msg.data);
                this.updateStatus("Error: " + msg.data);
                this.updateTitle();
                this.updateFavicon("error");
                // Surface the form (it may be dimmed mid auto-connect) so the
                // "Start Neovim" button is usable when nothing is listening.
                if (!this.connected) {
                    const form = document.getElementById("connection-form");
                    if (form) {
                        form.style.display = "block";
                        form.style.opacity = "1";
                    }
                }
                break;
            }
            case "redraw": {
                if (this.renderer && Array.isArray(msg.data)) {
                    this.renderer.handleRedrawEvent(msg.data);
                }
                break;
            }
            case "clipboard_set": {
                if (this.clipboardEnabled && msg.data) {
                    this.syncToSystemClipboard(msg.data);
                }
                break;
            }
            case "clipboard_get": {
                this.sendClipboardToNeovim();
                break;
            }
            case "open_preview": {
                if (msg.url) this.openPreview(msg.url, msg.label);
                break;
            }
            case "preview_resize": {
                this.adjustPreviewWidth(msg.delta || 0, true);
                break;
            }
            case "preview_resize_css": {
                this.adjustPreviewWidth(msg.delta || 0, false);
                break;
            }
            case "preview_commit": {
                this.commitPreviewWidth();
                break;
            }
            case "preview_reset": {
                this.setPreviewWidth(50, true);
                break;
            }
            case "close_preview": {
                this.closePreview(true);
                break;
            }
            case "close_preview_css": {
                this.closePreview(false);
                break;
            }
            case "show_form": {
                // Neovim asked to return to the session selection screen
                // (web_home). Surfaces the connection form + session list
                // without killing the underlying Neovim instance.
                this.showConnectionForm();
                break;
            }
            case "recompute_size": {
                // Neovim asked us to re-measure the viewport and resend the
                // grid size (recovery for a too-small initial attach). Reuse the
                // canonical window-resize path (handleResize) by dispatching a
                // synthetic resize event; resizeTerminalToFullViewport() uses a
                // different height (no -40 chrome offset) and would desync the
                // grid, pushing the status/cmdline off-screen.
                if (this.connected && this.renderer) {
                    globalThis.dispatchEvent(new Event("resize"));
                }
                break;
            }
            default: {
                console.log("Unknown message type:", msg.type);
            }
        }
    }

    autoConnect(address) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.connectToNeovim(address);
        } else {
            const checkConnection = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnection);
                    this.connectToNeovim(address);
                }
            }, 100);

            setTimeout(() => {
                clearInterval(checkConnection);
                this.updateStatus(
                    "Failed to establish WebSocket connection for auto-connect",
                );
            }, 5000);
        }
    }

    attachUI() {
        if (this.connected && this.ws && this.renderer) {
            this.ws.send(
                JSON.stringify({
                    type: "attach_ui",
                    width: this.renderer.cols,
                    height: this.renderer.rows,
                }),
            );
            this.renderer.startCursorBlink();
            this.updateStatus("UI attachment requested...");
        }
    }

    hideConnectionForm() {
        const connectionForm = document.getElementById("connection-form");
        const terminal = document.getElementById("terminal");

        if (connectionForm) {
            connectionForm.style.display = "none";
        }

        if (terminal) {
            terminal.classList.add("connected");
            terminal.style.display = "block";
        }

        this.resizeTerminalToFullViewport();
    }

    resizeTerminalToFullViewport() {
        const canvas = document.getElementById("terminal");
        if (!canvas || !this.renderer) return;

        // When the preview pane is open it takes previewWidthPct of the width on
        // the right; the terminal gets the rest. Keep this in sync with the pane
        // element width set in openPreview()/setPreviewWidth().
        const containerWidth = this.previewActive
            ? Math.floor(globalThis.innerWidth * (1 - this.previewWidthPct / 100))
            : globalThis.innerWidth;
        const containerHeight = globalThis.innerHeight;

        const newDimensions = this.renderer.resize(
            containerWidth,
            containerHeight,
        );
        this.sendResize(newDimensions.width, newDimensions.height);
    }

    openPreview(url, label) {
        const pane = document.getElementById("preview-pane");
        const frame = document.getElementById("preview-frame");
        if (!pane || !frame) return;

        const title = document.getElementById("preview-title");
        if (title) title.textContent = label || "Preview";

        frame.src = url;
        pane.style.width = this.previewWidthPct + "vw";
        pane.classList.add("active");
        this.previewActive = true;
        // 正規リサイズ経路(handleResize)に寄せる。resizeTerminalToFullViewport は
        // canvas寸法と chrome 高さ(-40)を欠きグリッドがズレるため使わない。
        globalThis.dispatchEvent(new Event("resize"));
    }

    // プレビューペイン幅(vw%)を設定。20–80% にクランプし、ターミナル側も再フロー。
    // pct: 目標幅(vw%)。reflow=true ならターミナルを即 reflow（従来動作・単発キー用）。
    // reflow=false なら CSS のみ更新し reflow は保留（submode 連打用、commit で反映）。
    setPreviewWidth(pct, reflow) {
        this.previewWidthPct = Math.max(20, Math.min(80, Math.round(pct)));
        const pane = document.getElementById("preview-pane");
        if (pane) pane.style.width = this.previewWidthPct + "vw"; // 幅は即時反映
        if (reflow && this.previewActive) {
            globalThis.dispatchEvent(new Event("resize"));
        }
        try {
            localStorage.setItem("previewWidthPct", String(this.previewWidthPct));
        } catch (e) { /* 無視 */ }
    }

    adjustPreviewWidth(deltaPct, reflow) {
        this.setPreviewWidth(this.previewWidthPct + deltaPct, reflow);
    }

    // 保留(reflow=false)していた幅変更をターミナル reflow に反映（submode 終了時）。
    commitPreviewWidth() {
        // 開いていても閉じていても現在の状態へ reflow（handleResize が previewActive で判定）
        globalThis.dispatchEvent(new Event("resize"));
    }

    closePreview(reflow = true) {
        const pane = document.getElementById("preview-pane");
        const frame = document.getElementById("preview-frame");
        if (pane) pane.classList.remove("active");
        if (frame) frame.src = "about:blank";
        this.previewActive = false;
        // reflow=false のときはターミナル reflow を保留（submode 連打中の中断回避）。
        // submode 終了時に commit() がまとめて reflow する。
        if (reflow) globalThis.dispatchEvent(new Event("resize"));

        this.focusInput();
    }

    connect() {
        const protocol = globalThis.location.protocol === "https:"
            ? "wss:"
            : "ws:";
        const wsUrl = `${protocol}//${globalThis.location.host}/ws`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.updateStatus("WebSocket connected");
            this.setupResizeHandler();
            this.setupMouseHandlers();
        };

        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            this.handleMessage(msg);
        };

        this.ws.onclose = () => {
            this.connected = false;
            this.updateStatus("WebSocket disconnected - Connection lost");
            this.updateTitle();
            this.updateFavicon("error");
            this.showConnectionForm();
        };

        this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            this.updateStatus("WebSocket error");
            this.updateFavicon("error");
            this.showConnectionForm();
        };
    }

    setupMouseHandlers() {
        const terminal = document.getElementById("terminal");
        if (!terminal) return;

        let dragThrottle = null;

        terminal.addEventListener("click", () => {
            this.focusInput();
        });

        terminal.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });

        terminal.addEventListener("focus", () => {
            if (this.connected && this.clipboardEnabled) {
                this.sendClipboardToNeovim();
            }
        });

        // Also sync on window focus
        globalThis.addEventListener("focus", () => {
            if (this.connected && this.clipboardEnabled) {
                this.sendClipboardToNeovim();
            }
        });

        terminal.addEventListener("mousedown", (event) => {
            if (!this.connected || !this.renderer) return;
            this.focusInput();

            const coords = this.getMouseCoords(event);
            this.sendMouseEvent("press", coords.row, coords.col, event.button);
            event.preventDefault();
        });

        terminal.addEventListener("mouseup", (event) => {
            if (!this.connected || !this.renderer) return;

            const coords = this.getMouseCoords(event);
            this.sendMouseEvent(
                "release",
                coords.row,
                coords.col,
                event.button,
            );
            event.preventDefault();
        });

        terminal.addEventListener("wheel", (event) => {
            if (!this.connected || !this.renderer) return;

            const coords = this.getMouseCoords(event);
            const direction = event.deltaY > 0 ? "down" : "up";
            this.sendScrollEvent(direction, coords.row, coords.col);
            event.preventDefault();
        });

        terminal.addEventListener("mousemove", (event) => {
            if (!this.connected || !this.renderer) return;

            if (event.buttons > 0) {
                if (!dragThrottle) {
                    dragThrottle = setTimeout(() => {
                        const coords = this.getMouseCoords(event);
                        this.sendMouseEvent(
                            "drag",
                            coords.row,
                            coords.col,
                            event.button,
                        );
                        dragThrottle = null;
                    }, 16);
                }
                event.preventDefault();
            }
        });
    }

    getMouseCoords(event) {
        const rect = event.target.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const col = Math.floor(x / this.renderer.cellWidth);
        const row = Math.floor(y / this.renderer.cellHeight);

        return {
            row: Math.max(0, Math.min(row, this.renderer.rows - 1)),
            col: Math.max(0, Math.min(col, this.renderer.cols - 1)),
        };
    }

    sendMouseEvent(action, row, col, button) {
        if (!this.connected || !this.ws) return;

        this.ws.send(
            JSON.stringify({
                type: "mouse",
                action: action,
                button: button,
                row: row,
                col: col,
                immediate: true,
            }),
        );
    }

    sendScrollEvent(direction, row, col) {
        if (!this.connected || !this.ws) return;

        this.ws.send(
            JSON.stringify({
                type: "scroll",
                direction: direction,
                row: row,
                col: col,
                immediate: true,
            }),
        );
    }

    // Keyboard focus lives on the hidden #ime-input textarea so that IME
    // (Japanese conversion) works reliably — a <canvas> is not an editable
    // element, so composition wouldn't start on it.
    focusInput() {
        const input = document.getElementById("ime-input");
        if (input) input.focus();
    }

    // Move the hidden input to the cursor cell so the IME candidate window
    // appears in the right place.
    positionInput() {
        const input = document.getElementById("ime-input");
        if (!input || !this.renderer) return;
        input.style.left = (this.renderer.cursor.col * this.renderer.cellWidth) + "px";
        input.style.top = (this.renderer.cursor.row * this.renderer.cellHeight) + "px";
    }

    setupKeyboardHandlers() {
        document.addEventListener("DOMContentLoaded", () => {
            const input = document.getElementById("ime-input");
            if (!input) {
                console.error("IME input element not found");
                return;
            }

            input.addEventListener("keydown", (event) => {
                if (!this.connected) return;
                // IME 変換中はキーを横取りせず textarea に任せる
                // (keyCode 229 は IME 処理中の keydown)
                if (event.isComposing || event.keyCode === 229) return;
                event.preventDefault();

                // GUI-style font zoom (Neovide-like). Handled in the client so
                // it never reaches Neovim. Ctrl +/=, Ctrl -, Ctrl 0 to reset.
                if (
                    event.ctrlKey && !event.altKey && !event.metaKey &&
                    this.renderer
                ) {
                    if (event.key === "=" || event.key === "+") {
                        this.renderer.zoomFont(1);
                        return;
                    }
                    if (event.key === "-" || event.key === "_") {
                        this.renderer.zoomFont(-1);
                        return;
                    }
                    if (event.key === "0") {
                        this.renderer.resetZoom();
                        return;
                    }
                }

                const key = this.translateKey(event);
                if (key) {
                    this.sendInput(key);
                }
            });

            // IME 未確定文字列をカーソル位置にインライン表示する。
            // 既定では textarea は透明・2ch幅なので未確定文字が見えず、IME が独自の
            // 変換ウィンドウに出してしまう。変換中だけ可視化してグリッド同色で重ねる。
            const showPreedit = () => {
                const r = this.renderer;
                if (!r) return;
                this.positionInput();
                input.style.font = `${r.fontSize}px ${r.fontFamily}`;
                input.style.height = r.cellHeight + "px";
                input.style.lineHeight = r.cellHeight + "px";
                input.style.color = (r.colors && r.colors.fg) || "#ffffff";
                input.style.background = (r.colors && r.colors.bg) || "#1e1e1e";
                input.style.caretColor = (r.colors && r.colors.fg) || "#ffffff";
                input.style.zIndex = "50";
                sizePreedit();
            };
            // 未確定文字列の表示幅をグリッドのセル数に合わせる（全角は2セル扱い）。
            const sizePreedit = () => {
                const r = this.renderer;
                if (!r) return;
                let cols = 0;
                for (const ch of input.value) {
                    cols += ch.codePointAt(0) > 0x10ff ? 2 : 1;
                }
                input.style.width = Math.max(2, cols + 1) * r.cellWidth + "px";
            };
            // 変換確定後は元の不可視状態へ戻す。
            const hidePreedit = () => {
                input.style.color = "transparent";
                input.style.background = "transparent";
                input.style.caretColor = "transparent";
                input.style.width = "2ch";
                input.style.zIndex = "5";
            };

            input.addEventListener("compositionstart", () => showPreedit());
            input.addEventListener("compositionupdate", () => sizePreedit());
            // IME 変換確定: 確定文字列を Neovim に送り、textarea を空に戻す
            input.addEventListener("compositionend", (event) => {
                const text = event.data;
                input.value = "";
                hidePreedit();
                if (text) this.sendInput(text);
            });

            // フォーカスが textarea に移ったので paste もここで受ける
            input.addEventListener("paste", (event) => {
                if (!this.connected) return;
                event.preventDefault();
                const text = event.clipboardData.getData("text");
                if (text) this.sendInput(text);
            });

            this.focusInput();
        });
    }

    translateKey(event) {
        const { key, code, ctrlKey, altKey, shiftKey, metaKey } = event;

        // for <LT> See
        // https://pkg.go.dev/github.com/neovim/go-client/nvim#Nvim.Input
        const specialKeys = {
            Enter: "<CR>",
            Escape: "<Esc>",
            Backspace: "<BS>",
            Tab: "<Tab>",
            Delete: "<Del>",
            Insert: "<Insert>",
            Home: "<Home>",
            End: "<End>",
            PageUp: "<PageUp>",
            PageDown: "<PageDown>",
            ArrowUp: "<Up>",
            ArrowDown: "<Down>",
            ArrowLeft: "<Left>",
            ArrowRight: "<Right>",
            " ": "<Space>",
            "<": "<LT>",
        };

        for (let i = 1; i <= 12; i++) {
            specialKeys[`F${i}`] = `<F${i}>`;
        }

        let modifiers = "";

        if (ctrlKey) {
            modifiers += "C-";
        }

        if (altKey) {
            modifiers += "A-";
        }

        if (metaKey) {
            modifiers += "D-";
        }

        if (shiftKey && !this.isShiftableKey(key)) {
            modifiers += "S-";
        }

        if (specialKeys[key]) {
            if (modifiers) {
                return `<${modifiers}${specialKeys[key].slice(1, -1)}>`;
            }
            return specialKeys[key];
        }

        if (key.length === 1) {
            if (modifiers) {
                if (ctrlKey && !altKey && !metaKey) {
                    return `<C-${key.toLowerCase()}>`;
                }
                return `<${modifiers}${key}>`;
            }
            return key;
        }

        if (code.startsWith("Numpad")) {
            const numpadKeys = {
                Numpad0: "0",
                Numpad1: "1",
                Numpad2: "2",
                Numpad3: "3",
                Numpad4: "4",
                Numpad5: "5",
                Numpad6: "6",
                Numpad7: "7",
                Numpad8: "8",
                Numpad9: "9",
                NumpadDecimal: ".",
                NumpadAdd: "+",
                NumpadSubtract: "-",
                NumpadMultiply: "*",
                NumpadDivide: "/",
                NumpadEnter: "<CR>",
            };

            if (numpadKeys[code]) {
                if (modifiers) {
                    return `<${modifiers}${numpadKeys[code]}>`;
                }
                return numpadKeys[code];
            }
        }

        console.log("Unhandled key:", {
            key,
            code,
            ctrlKey,
            altKey,
            shiftKey,
            metaKey,
        });
        return null;
    }

    isShiftableKey(key) {
        const shiftableKeys = [
            "!",
            "@",
            "#",
            "$",
            "%",
            "^",
            "&",
            "*",
            "(",
            ")",
            "_",
            "+",
            "{",
            "}",
            "|",
            ":",
            '"',
            "<",
            ">",
            "?",
            "~",
            "A",
            "B",
            "C",
            "D",
            "E",
            "F",
            "G",
            "H",
            "I",
            "J",
            "K",
            "L",
            "M",
            "N",
            "O",
            "P",
            "Q",
            "R",
            "S",
            "T",
            "U",
            "V",
            "W",
            "X",
            "Y",
            "Z",
        ];
        return shiftableKeys.includes(key) || key.length === 1;
    }

    setupResizeHandler() {
        let resizeTimeout;

        const handleResize = () => {
            if (!this.connected || !this.renderer) return;

            const canvas = document.getElementById("terminal");
            if (!canvas) return;

            const connectionForm = document.getElementById("connection-form");
            const isFormVisible = connectionForm &&
                connectionForm.style.display !== "none";

            let containerWidth, containerHeight;

            if (isFormVisible) {
                const formHeight = connectionForm.offsetHeight + 40;
                containerWidth = globalThis.innerWidth;
                containerHeight = globalThis.innerHeight - formHeight - 40;
            } else {
                // プレビューペインが開いている時はその幅を引いた残りがターミナル。
                containerWidth = this.previewActive
                    ? Math.floor(globalThis.innerWidth * (1 - this.previewWidthPct / 100))
                    : globalThis.innerWidth;
                containerHeight = globalThis.innerHeight - 40;
            }

            canvas.style.width = containerWidth + "px";
            canvas.style.height = containerHeight + "px";

            const newDimensions = this.renderer.resize(
                containerWidth,
                containerHeight,
            );
            this.sendResize(newDimensions.width, newDimensions.height);
        };

        globalThis.addEventListener("resize", () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(handleResize, 100);
        });

        setTimeout(handleResize, 100);
    }

    sendResize(width, height) {
        if (
            this.connected && this.ws && this.ws.readyState === WebSocket.OPEN
        ) {
            this.ws.send(
                JSON.stringify({
                    type: "resize",
                    width: width,
                    height: height,
                    immediate: true,
                }),
            );
        }
    }

    connectToNeovim(address) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.updateStatus("Reconnecting to server...");
            this.connect();

            const checkConnection = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnection);
                    this.ws.send(
                        JSON.stringify({
                            type: "connect",
                            address: address,
                        }),
                    );
                }
            }, 100);

            setTimeout(() => {
                clearInterval(checkConnection);
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this.updateStatus("Failed to reconnect to server");
                }
            }, 5000);
        } else {
            this.ws.send(
                JSON.stringify({
                    type: "connect",
                    address: address,
                }),
            );
        }
    }

    async refreshSessions() {
        const list = document.getElementById("session-list");
        if (!list) return;
        try {
            const res = await fetch("/sessions");
            const sessions = await res.json();
            list.innerHTML = "";
            if (!sessions || sessions.length === 0) {
                list.textContent = "No running sessions";
                return;
            }
            for (const s of sessions) {
                const btn = document.createElement("button");
                btn.className = "session-item";
                btn.textContent = `${s.label}  (${s.name})`;
                btn.title = s.address;
                btn.onclick = () => this.connectToNeovim(s.address);
                list.appendChild(btn);
            }
        } catch (_e) {
            list.textContent = "Failed to list sessions";
        }
    }

    startSession(name) {
        this.updateStatus("Starting session '" + name + "'...");
        const payload = JSON.stringify({ type: "spawn", name: name });

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connect();
            const checkConnection = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnection);
                    this.ws.send(payload);
                }
            }, 100);
            setTimeout(() => {
                clearInterval(checkConnection);
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this.updateStatus("Failed to reconnect to server");
                }
            }, 5000);
        } else {
            this.ws.send(payload);
        }
    }

    startNeovim(address) {
        this.updateStatus("Starting Neovim at " + address + "...");
        const payload = JSON.stringify({ type: "spawn", address: address });

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connect();
            const checkConnection = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnection);
                    this.ws.send(payload);
                }
            }, 100);
            setTimeout(() => {
                clearInterval(checkConnection);
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this.updateStatus("Failed to reconnect to server");
                }
            }, 5000);
        } else {
            this.ws.send(payload);
        }
    }

    updateStatus(message) {
        const statusDiv = document.getElementById("status");
        if (statusDiv) {
            statusDiv.textContent = message;
        }
    }

    sendInput(input) {
        if (
            this.connected && this.ws && this.ws.readyState === WebSocket.OPEN
        ) {
            this.ws.send(
                JSON.stringify({
                    type: "input",
                    data: input,
                    immediate: true,
                }),
            );
        }
    }

    sendCommand(command) {
        if (this.connected && this.ws) {
            this.ws.send(
                JSON.stringify({
                    type: "command",
                    data: command,
                    immediate: true,
                }),
            );
        }
    }

    async syncToSystemClipboard(text) {
        if (!this.clipboardEnabled || text === this.lastClipboardContent) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            this.lastClipboardContent = text;
        } catch (err) {
            console.error("Failed to sync clipboard:", err);
        }
    }

    async sendClipboardToNeovim() {
        if (!this.clipboardEnabled) {
            return;
        }
        try {
            const text = await navigator.clipboard.readText();
            if (this.connected && this.ws) {
                this.ws.send(
                    JSON.stringify({
                        type: "clipboard_content",
                        data: text,
                    }),
                );
            }
        } catch (err) {
            console.error("Failed to read clipboard:", err);
            // Send empty content on error
            if (this.connected && this.ws) {
                this.ws.send(
                    JSON.stringify({
                        type: "clipboard_content",
                        data: "",
                    }),
                );
            }
        }
    }

    async requestClipboardPermission() {
        if (!navigator.clipboard || !globalThis.isSecureContext) {
            console.warn("Clipboard API not available (requires HTTPS)");
            return false;
        }
        try {
            const permission = await navigator.permissions.query({
                name: "clipboard-read",
            });
            if (permission.state === "granted") {
                this.clipboardEnabled = true;
                return true;
            } else if (permission.state === "prompt") {
                await navigator.clipboard.readText();
                this.clipboardEnabled = true;
                return true;
            }
        } catch (_err) {
            this.clipboardEnabled = false;
        }
        return false;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = NeovimClient;
}
