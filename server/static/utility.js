function getUrlParameter(name) {
	const urlParams = new URLSearchParams(window.location.search);
	return urlParams.get(name);
}

function isValidServerAddress(address) {
	// host:port (TCP) or an absolute path (unix socket session).
	const tcp = /^[a-zA-Z0-9.-]+:\d+$/;
	const socket = /^\/.+/;
	return tcp.test(address) || socket.test(address);
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = { getUrlParameter, isValidServerAddress };
}
