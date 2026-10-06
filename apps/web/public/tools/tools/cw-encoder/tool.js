// SPDX-License-Identifier: MIT
// CW encoder 1.0.0, built by scripts/build.mjs from tools/cw-encoder/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // vendor/aprscaching/packages/tools/src/decoders/morse.ts
  var MORSE = {
    A: ".-",
    B: "-...",
    C: "-.-.",
    D: "-..",
    E: ".",
    F: "..-.",
    G: "--.",
    H: "....",
    I: "..",
    J: ".---",
    K: "-.-",
    L: ".-..",
    M: "--",
    N: "-.",
    O: "---",
    P: ".--.",
    Q: "--.-",
    R: ".-.",
    S: "...",
    T: "-",
    U: "..-",
    V: "...-",
    W: ".--",
    X: "-..-",
    Y: "-.--",
    Z: "--..",
    "0": "-----",
    "1": ".----",
    "2": "..---",
    "3": "...--",
    "4": "....-",
    "5": ".....",
    "6": "-....",
    "7": "--...",
    "8": "---..",
    "9": "----.",
    ".": ".-.-.-",
    ",": "--..--",
    "?": "..--..",
    "/": "-..-.",
    "=": "-...-",
    "-": "-....-",
    ":": "---...",
    "'": ".----.",
    "@": ".--.-.",
    "(": "-.--.",
    ")": "-.--.-"
  };
  var REV = Object.fromEntries(Object.entries(MORSE).map(([c, m]) => [m, c]));
  function encodeMorse(text) {
    return text.toUpperCase().split(/\s+/).filter(Boolean).map(
      (word) => [...word].map((c) => MORSE[c] ?? "").filter(Boolean).join(" ")
    ).join(" / ");
  }

  // tools/cw-encoder/src/index.js
  register({
    commands: {
      cw: (args) => {
        const t = args.trim();
        return t ? [encodeMorse(t)] : ["Usage: /cw <text>"];
      }
    }
  });
})();
