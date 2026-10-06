// SPDX-License-Identifier: MIT
/* global register, tool */
// Tool API 1.0 contract fixture: a tool granted only `command` reaches for what it was not granted, and is refused
// in its worker, as every 1.x release must refuse it.
const tryIt = (fn) => {
  try {
    fn();
    return "allowed";
  } catch {
    return "refused";
  }
};
register({
  commands: {
    reach: () => [
      tryIt(() => tool.setMapLayer({ id: "x", points: [] })),
      tryIt(() => tool.on("on_frame", () => {})),
      tryIt(() => tool.requestTx(">x")),
    ],
  },
});
