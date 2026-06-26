# Neovim in the Browser

> **Note:** This is a personal fork of
> [Kraust/nvim-server](https://github.com/Kraust/nvim-server) with additional,
> fairly opinionated features (offline preview dispatcher, multi-session
> handling, IME input, etc.). It is maintained for my own workflow and is not
> intended to be upstreamed. See [Licensing](#licensing) below.

<img width="1960" height="1120" alt="Screenshot from 2025-08-30 20-58-16" src="https://github.com/user-attachments/assets/a84ab3c0-176b-4b3d-a413-5586fde4c7e3" />

`nvim-server` is a web frontend for [Neovim](https://neovim.io/) designed around
allowing the user to run Neovim anywhere you have a browser.

Note this project was vibe coded over a two day period, and I'm at the point in
which I believe I have a minimal viable product. Next steps include addressing
roadmap items and trying to refactor / understand parts of the code I had the
AI generate. Right now I'd consider nvim-server an MVP based on my personal
requirements.

## Features

- One server can connect to multiple clients.
- Full clipboard integration using a custom clipboard provider.
- GPU acceleration.

## Usage

First spawn the server:

```
$ ./nvim-server --address 0.0.0.0:9998
```

Then you can go to `http://localhost:9998` and enter the location of a remote
neovim instance. You can optionally pass in the server address as a query
string (e.g. `http://localhost:9998/?server=localhost:9000`) to automatically
connect to your Neovim instance.

Optionally, you can create a systemd unit to automate this entire process:

```
[Unit]
Description=nvim-server

[Service]
ExecStart=nvim-server --address 0.0.0.0:9998
Restart=always
# Neovim instances spawned via "Start Neovim" are child processes in this
# unit's cgroup, so the default KillMode (control-group) kills them on
# restart. Use "process" to replace only nvim-server and keep sessions alive.
KillMode=process

[Install]
WantedBy=default.target
```

Note that if your nvim-server and nvim are on different LANs you may want to
use a secure tunnel to encrypt your neovim RPC traffic.

## Clipboard Support

Clipboard Support requires the user to have nvim-server running behind HTTPS
as browsers block clipboard sharing for HTTP connections.

## Project Background

Before starting this project I wrote a couple of blog posts about Neovim being
a terminal emulator / multiplexer replacement. I may write future posts in the
future elaborating on why Neovim in the browser was my eventual conclusion for
creating an optimal development workflow.

- [Remote Neovim for Dummies](https://kraust.github.io/posts/remote-neovim-for-dummies/)
- [Neovim is a Multiplexer](https://kraust.github.io/posts/neovim-is-a-multiplexer/)

## Roadmap

- Better font rendering support.

## Similar Projects

- [Code Server](https://github.com/coder/code-server) - VSCode in the Browser
- [Glowing Bear](https://github.com/glowing-bear/glowing-bear) - WeeChat in the Browser
- [Neovide](https://github.com/neovide/neovide) - An amazing Neovim GUI that I've been using since 2020.

## Licensing

This project is MIT licensed (see [`LICENSE`](LICENSE)). It is a fork of
[Kraust/nvim-server](https://github.com/Kraust/nvim-server); the original
copyright is retained and fork modifications are added under the same license.

Third-party libraries bundled under `server/static/vendor/` (three.js, Chart.js,
dxf) are distributed under their own MIT licenses; see
[`server/static/vendor/LICENSES.md`](server/static/vendor/LICENSES.md) for the
notices.

