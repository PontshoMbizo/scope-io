// Kept for existing imports: the embed props now live in lib/simulators.js.
import { embedProps } from "./simulators";

export const EMBED_CONFIG = {
  fpga: embedProps("fpga"),
  mcu: embedProps("mcu"),
  fulgurlab: embedProps("fulgurlab"),
  fulgurspice: embedProps("fulgurspice"),
};
