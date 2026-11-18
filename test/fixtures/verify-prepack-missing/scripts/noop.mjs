// The control's prepack hook: it runs successfully and deliberately writes
// nothing. `client.js` is never generated, so `npm pack` ships no panel.
process.exit(0);
