// Décodeur BMS Hyundai E-GMP (Ioniq 5).
// 1) Réassemble la réponse ISO-TP multi-trames (lignes "7EC 10 3E ..." / "7EC 21 ...").
// 2) Extrait les grandeurs des réponses 220101 (bloc batterie) et 220105 (SOH, SOC affiché).
//
// Offsets validés contre les trames réelles de la voiture (ancres : SOC affiché 100 %,
// température extérieure 30 °C, SOH 100 % certifié Hyundai). À affiner avec un test à SOC
// intermédiaire / en roulant / en charge pour lever les dernières ambiguïtés.

export function reassembleIsoTp(text) {
  const data = [];
  let expectedLen = null;
  for (const line of String(text).trim().split('\n')) {
    // garde uniquement les octets hex (jette l'en-tête "7EC" en 3 caractères et "SEARCHING...").
    const bytes = line.trim().split(/\s+/)
      .filter((t) => /^[0-9A-Fa-f]{2}$/.test(t))
      .map((h) => parseInt(h, 16));
    if (!bytes.length) continue;
    const type = bytes[0] >> 4;
    if (type === 1) { // First Frame
      expectedLen = ((bytes[0] & 0x0f) << 8) | bytes[1];
      data.push(...bytes.slice(2));
    } else if (type === 2) { // Consecutive Frame
      data.push(...bytes.slice(1));
    } else if (type === 0) { // Single Frame
      expectedLen = bytes[0] & 0x0f;
      data.push(...bytes.slice(1));
    }
  }
  return expectedLen == null ? data : data.slice(0, expectedLen);
}

const i16 = (h, l) => { const v = (h << 8) | l; return v > 0x7fff ? v - 0x10000 : v; };
const u16 = (h, l) => (h << 8) | l;
const i8 = (b) => (b > 0x7f ? b - 0x100 : b);

// Réponse à 220101 : courant, tension, températures batterie.
export function decode0101(b) {
  if (!b || b.length < 24 || b[0] !== 0x62) return null;
  const currentA = i16(b[13], b[14]) / 10;
  const voltageV = u16(b[15], b[16]) / 10;
  const temps = b.slice(17, 24).map(i8);
  return {
    currentA,
    voltageV,
    powerKw: +((currentA * voltageV) / 1000).toFixed(2),
    tempsC: temps,
    tempMinC: Math.min(...temps),
    tempMaxC: Math.max(...temps),
  };
}

// Réponse à 220105 : SOH, SOC affiché.
export function decode0105(b) {
  if (!b || b.length < 35 || b[0] !== 0x62) return null;
  return {
    sohPct: u16(b[28], b[29]) / 10,
    socDisplayPct: b[34] / 2,
  };
}
