// Real captured PTY bytes from claude 2.1.186, for the GEOMETRY-MISMATCH
// regression (web-attach "doubled / stacked screen").
//
// Empirical root cause (proven against real claude bytes): the web client reports
// a WRONG pre-layout terminal size when it sends `attach` — `fit()` runs
// synchronously right after `term.open()`, before the flex layout (AgentKeyBar +
// ActionBar siblings) has been measured, so it reads a desktop-ish wide/short
// fallback (~80x24) instead of the true tall/narrow phone viewport (~50x80). The
// bridge resizes the daemon PTY to that reported size, claude repaints at it, and
// the SerializeAddon snapshots the WIDE geometry. The web then writes that seed
// into an xterm at its TRUE narrow size and never resizes to the snapshot — so the
// wide snapshot's wrapped banner + relative cursor restore land at the wrong
// baseline: doubled banner, stacked input box, leftover fragments.
//
// CAPTURE PROCEDURE (regenerate via scratchpad/gen-geometry-fixture.mjs):
//   1. spawn claude in a PRE-TRUSTED temp dir at SIZE_A (80x24) so it boots
//      straight to the alt-screen UI (no trust dialog confound).
//   2. let the banner + input box settle, type "hello world test line" (no Enter)
//      so there is identifiable committed/active content to detect doubling.
//   3. capture the full stream rendered at SIZE_A  -> GEO_BOOT_A_B64
//   4. pty.resize to SIZE_B (50x80); capture the SIGWINCH repaint -> GEO_RESIZE_B_B64
//
// Rebuild the daemon mirror by writing GEO_BOOT_A_B64 into a headless Terminal at
// SIZE_A, then (for the B geometry) resize to SIZE_B and write GEO_RESIZE_B_B64.
// Serialize each with SerializeAddon to get the size-A and size-B snapshots.

export const GEO_SIZE_A = { cols: 80, rows: 24 } as const
export const GEO_SIZE_B = { cols: 50, rows: 80 } as const

// Full stream rendered at SIZE_A (80x24), banner+input box+typed text.
export const GEO_BOOT_A_B64 =
  'GzcbW3IbOBtbPzI1aBtbPzI1bBtbPzIwMDRoG1s/MTAwNGgbWz8yMDMxaBtbPjBxG1tjG1s/MTA0OWgbWzJKG1tIG1s/MTAwMGgbWz8xMDAyaBtbPzEwMDNoG1s/MTAwNmgbXTA74pyzIENsYXVkZSBDb2RlBxtbSA0bWzFCG1szODsyOzIxNTsxMTk7ODdtIOKWkBtbNDg7MjswOzA7MG3ilpvilojilojilojilpwbWzQ5beKWjBtbMTJHG1szOW0bWzFtQ2xhdWRlIENvZGUbWzI0RxtbMjJtG1szODsyOzE1MzsxNTM7MTUzbXYyLjEuMTg2DRtbMUIbWzM4OzI7MjE1OzExOTs4N23ilp3ilpwbWzQ4OzI7MDswOzBt4paI4paI4paI4paI4paIG1s0OW3ilpvilpgbWzEyRxtbMzg7MjsxNTM7MTUzOzE1M21PcHVzIDQuOCAoMU0gY29udGV4dCkgd2l0aCBoaWdoIGVmZm9ydCDCtyBDbGF1ZGUgTWF4DRtbMUIbWzM4OzI7MjE1OzExOTs4N20gIOKWmOKWmCDilp3ilp0gIBtbMTJHG1szODsyOzE1MzsxNTM7MTUzbS/igKYvd3MvMjd2eDFwNzk1MXY2OHduOTM5MTRqd2RyMDAwMGduL1QvY2xhdWRlLWdlb2ZpeC0yd2YweksNG1s2M0MbWzE2QuKXjyBoaWdoIMK3IC9lZmZvcnQNG1sxQhtbMzg7MjsxMzY7MTM2OzEzNm3ilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANG1sxQhtbMzlt4p2vwqAbWzJtVHJ5ICJyZWZhY3RvciA8ZmlsZXBhdGg+Ig0bWzFCG1syMm0bWzM4OzI7MTM2OzEzNjsxMzZt4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADRtbMkMbWzFCG1szODsyOzE1MzsxNTM7MTUzbT8gZm9yIHNob3J0Y3V0cyDCtyDihpAgZm9yIGFnZW50cxtbMzltG1syNDsxSBtbMjI7M0gbWz8yNWgbWz8yNWwbW0gNG1syQxtbMjFCG1tLG1syNDsxSBtbMjI7M0gbWz8yNWgbWz8yNWwbW0gNG1syQxtbMjFCaGVsbG8bWzlHd29ybGQbWzE1R3Rlc3QbWzIwR2xpbmUNG1syQxtbMkIbW0sbWzI0OzFIG1syMjsyNEgbWz8yNWg='

// SIGWINCH repaint emitted by claude after resizing SIZE_A -> SIZE_B (50x80).
export const GEO_RESIZE_B_B64 =
  'G1s/MTAwMGgbWz8xMDAyaBtbPzEwMDNoG1s/MTAwNmgbWz8yNWwbWzJKG1tIDRtbMTFDG1sxQhtbMW1DbGF1ZGUgQ29kZRtbMjRHG1syMm0bWzM4OzI7MTUzOzE1MzsxNTNtdjIuMS4xODYNG1sxQhtbMzg7MjsyMTU7MTE5Ozg3bSDilpAbWzQ4OzI7MDswOzBt4pab4paI4paI4paI4pacG1s0OW3ilowbWzEyRxtbMzg7MjsxNTM7MTUzOzE1M21PcHVzIDQuOCAoMU0gY29udGV4dCkgd2l0aCBoaWdoIGVm4oCmDRtbMUIbWzM4OzI7MjE1OzExOTs4N23ilp3ilpwbWzQ4OzI7MDswOzBt4paI4paI4paI4paI4paIG1s0OW3ilpvilpgbWzEyRxtbMzg7MjsxNTM7MTUzOzE1M21DbGF1ZGUgTWF4DRtbMUIbWzM4OzI7MjE1OzExOTs4N20gIOKWmOKWmCDilp3ilp0gIBtbMTJHG1szODsyOzE1MzsxNTM7MTUzbS/igKYvVC9jbGF1ZGUtZ2VvZml4LTJ3ZjB6Sw0bWzMzQxtbNzFC4pePIGhpZ2ggwrcgL2VmZm9ydA0bWzFCG1szODsyOzEzNjsxMzY7MTM2beKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0bWzFCG1szOW3ina/CoGhlbGxvG1s5R3dvcmxkG1sxNUd0ZXN0G1syMEdsaW5lDRtbMUIbWzM4OzI7MTM2OzEzNjsxMzZt4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAG1szOW0bWzgwOzFIG1s3ODsyNEgbWz8yNWg='
