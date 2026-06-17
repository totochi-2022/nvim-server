// Global client instance
const client = new NeovimClient();
globalThis.client = client;

// Setup keyboard handlers
client.setupKeyboardHandlers();

// Window load handler
globalThis.addEventListener("load", () => {
    client.connect();
    client.refreshSessions();

    const serverAddress = getUrlParameter("server");
    if (serverAddress && isValidServerAddress(serverAddress)) {
        const connectionForm = document.getElementById("connection-form");
        if (connectionForm) {
            connectionForm.style.opacity = "0.5";
        }

        const addressInput = document.getElementById("nvim-address");
        if (addressInput) {
            addressInput.value = decodeURIComponent(serverAddress);
        }

        setTimeout(() => {
            client.updateStatus("Auto-connecting to " + serverAddress + "...");
            client.updateTitle(serverAddress + " (connecting...)");
            client.updateFavicon("default");
            client.connectToNeovim(decodeURIComponent(serverAddress));
        }, 500);
    }
});

// Terminal event handlers
const terminal = document.getElementById("terminal");

terminal.addEventListener("keyup", (_event) => {
    if (!client.connected) return;
});

terminal.addEventListener("paste", (event) => {
    if (!client.connected) return;

    event.preventDefault();
    const text = event.clipboardData.getData("text");
    client.sendInput(text);
});

// Global connection function
globalThis.connectToNeovim = function () {
    const addressInput = document.getElementById("nvim-address");
    if (!addressInput) {
        console.error("Address input not found");
        return;
    }

    const address = addressInput.value;

    if (address.trim()) {
        client.connectToNeovim(address);
    } else {
        client.updateStatus("Please enter a valid address");
    }
};

// Start a Neovim instance on the server host, then connect to it. Used when the
// target address isn't listening yet.
globalThis.startNeovim = function () {
    const addressInput = document.getElementById("nvim-address");
    if (!addressInput) {
        console.error("Address input not found");
        return;
    }

    const address = addressInput.value;

    if (address.trim()) {
        client.startNeovim(address);
    } else {
        client.updateStatus("Please enter a valid address");
    }
};

// Close the markdown preview pane.
globalThis.closePreview = function () {
    client.closePreview();
};

// Refresh the list of discoverable Neovim sessions.
globalThis.refreshSessions = function () {
    client.refreshSessions();
};

// Start a new named (socket) session and connect to it.
globalThis.startSession = function () {
    const nameInput = document.getElementById("session-name");
    const name = nameInput ? nameInput.value.trim() : "";
    if (name) {
        client.startSession(name);
    } else {
        client.updateStatus("Enter a session name");
    }
};
