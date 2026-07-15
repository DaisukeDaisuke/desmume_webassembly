// Log-oriented port of overlay_jp.lua. The original gui overlay becomes concise,
// periodic console rows intended for AI inspection through listScriptPrint.

const CPU = "arm9";
const LOADED_OVERLAY_TABLE = 0x01ffd384;
const WHERE_TO_LOAD_TABLE = 0x020e9034;
const Y9_BIN_START = 0x01ffd3b4;
const reg = (name) => memory.reg(name, CPU);
const loaded = new Map();
let enabled = true;
let previousButton = 0;
let nextCheckFrame = 0;

function swap32(value) {
  const n = Number(value) >>> 0;
  return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | ((n >>> 24) & 0xff)) >>> 0;
}

async function native32(address) {
  return swap32(await memory.read32(address, CPU));
}

async function overlayStart(overlayId) {
  return native32(Y9_BIN_START + overlayId * 0x2c + 4);
}

async function overlaySlot(overlayId) {
  return native32(WHERE_TO_LOAD_TABLE + overlayId * 8);
}

async function refreshSlots(forceLog = false) {
  const next = new Map();
  const rows = [];
  for (let slot = 0; slot <= 5; slot++) {
    const id = await memory.read8(LOADED_OVERLAY_TABLE + slot, CPU);
    if (id !== 0xff && (id & 0x40) !== 0x40) {
      const start = await overlayStart(id);
      next.set(slot, { id, start });
      const previous = loaded.get(slot);
      if (forceLog || !previous || previous.id !== id || previous.start !== start) rows.push(`slot ${slot}: id ${id} start 0x${start.toString(16).padStart(8, "0")}`);
    } else {
      if (forceLog || loaded.has(slot)) rows.push(`slot ${slot}: nil`);
    }
  }
  loaded.clear();
  next.forEach((value, slot) => loaded.set(slot, value));
  if (enabled) rows.forEach((row) => print(row));
}

async function trace(callback) {
  try {
    await callback();
  } finally {
    await mcp.call("resume");
  }
}

await memory.registerexec(0x020a36b8, () => trace(async () => {
  const id = await reg("r0");
  const slot = await overlaySlot(id);
  const start = await overlayStart(id);
  const lr = await reg("r14");
  loaded.set(slot, { id, start, lr});
  print(`overlay loaded: slot ${slot}, id ${id}, start 0x${start.toString(16).padStart(8, "0")}, caller: 0x${lr.toString(16).padStart(8, "0")}`);
}), { cpu: CPU });

await memory.registerexec(0x020a392c, () => trace(async () => {
  const id = await reg("r0");
  const slot = await overlaySlot(id);
  loaded.delete(slot);
  print(`overlay unloaded: slot 0x${slot.toString(16).padStart(8, "0")}, id ${id}`);
}), { cpu: CPU });

await refreshSlots(true);
emu_ontick(async ({ frame }) => {
  const button = (await memory.read8(0x04000130, CPU)) & 0x0f;
  if (button === 7 && previousButton !== 7) {
    enabled = !enabled;
    print(`overlay log ${enabled ? "enabled" : "disabled"}`);
  }
  previousButton = button;
  if (enabled && frame >= nextCheckFrame) {
    nextCheckFrame = frame + 60;
    await refreshSlots(false);
  }
});

print("overlay logger registered; press the original button chord to toggle output");
