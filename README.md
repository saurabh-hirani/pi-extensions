This repo is a a collection of pi extensions built by a small group of friends
who want to learn pi together.

There are no specific contribution guidelines as the project is in its nascent
stages and a learning experiment.

### Installing an extension

Run `./install.sh`. This will bring up a TUI which will let you toggle extensions on and off.

Toggle on = Symlink the extension file to your `~/.pi/agent/extensions` directory.
Toggle off = Remove the symlink from your `~/.pi/agent/extensions` directory.

The purpose of this script is to make it easy to install/uninstall extensions
from here that you have not authored.

### Saurabh Hirani

1. [pi vim extension](./saurabh-hirani/.pi/agent/extensions/pi-vim.ts)
2. [pi permission gate + nvim diff extension](./saurabh-hirani/.pi/agent/extensions/permission-gate.ts)

### Srijan Shukla

1. [rtk extension](./srijanshukla18/.pi/agent/extensions/rtk.ts) _(requires [`rtk`](https://github.com/rtk-ai/rtk) to be installed)_
2. [token speed extension](./srijanshukla18/.pi/agent/extensions/token-speed.ts) (live assistant tokens/s on statusline)

### Arjun Mahishi

1. [web extension](./arjunmahishi/.pi/agent/extensions/web.ts)
