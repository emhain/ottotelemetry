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
const u32 = (a, b, c, d) => a * 16777216 + b * 65536 + c * 256 + d;
const i8 = (b) => (b > 0x7f ? b - 0x100 : b);

// Réponse à 220101 : SOC BMS, courant, tension, cellules, températures, énergie cumulée, prise.
// Offsets validés sur trames réelles + référence Torque Ioniq 5 (Esprit1st).
export function decode0101(b) {
  if (!b || b.length < 29 || b[0] !== 0x62) return null;
  const currentA = i16(b[13], b[14]) / 10;
  const voltageV = u16(b[15], b[16]) / 10;
  const temps = b.slice(17, 24).map(i8);
  const cellVMax = b[26] / 50;
  const cellVMin = b[28] / 50;
  const out = {
    socBmsPct: b[7] / 2,
    currentA,
    voltageV,
    powerKw: +((currentA * voltageV) / 1000).toFixed(2),
    cellVMax,
    cellVMin,
    cellDeltaMv: Math.round((cellVMax - cellVMin) * 1000),
    tempsC: temps,
    tempMinC: Math.min(...temps),
    tempMaxC: Math.max(...temps),
  };
  if (b.length > 32) out.aux12vV = +(b[32] * 0.1).toFixed(1); // batterie 12 V (réf Torque ad*0.1)
  // Champs présents dans la trame complète (62 octets) :
  if (b.length >= 49) {
    out.energyChargedKwh = u32(b[41], b[42], b[43], b[44]) / 10; // compteur à vie
    out.energyDischargedKwh = u32(b[45], b[46], b[47], b[48]) / 10;
    out.acPlugged = !!((b[12] >> 5) & 1);
    out.dcPlugged = !!((b[12] >> 6) & 1);
  }
  return out;
}

// Réponse à 22C00B (en-tête 7A0) : pression (psi ÷5 → bar) et température (octet −50) des 4 pneus.
const PSI_TO_BAR = 0.0689476;
export function decodeTpms(b) {
  if (!b || b.length < 23 || b[0] !== 0x62) return null;
  const tire = (p, t) => ({ bar: +((b[p] / 5) * PSI_TO_BAR).toFixed(2), tempC: b[t] - 50 });
  return { fl: tire(7, 8), fr: tire(12, 13), bl: tire(17, 18), br: tire(22, 23) };
}

// Réponse à 22B002 (en-tête 7C6, combiné d'instruments) : odomètre en km (Int24).
export function decodeOdometer(b) {
  if (!b || b.length < 12 || b[0] !== 0x62 || b[1] !== 0xb0 || b[2] !== 0x02) return null;
  return (b[9] << 16) + (b[10] << 8) + b[11]; // km
}

// Réponse à 220105 : SOH, SOC affiché.
export function decode0105(b) {
  if (!b || b.length < 35 || b[0] !== 0x62) return null;
  return {
    sohPct: u16(b[28], b[29]) / 10,
    socDisplayPct: b[34] / 2,
  };
}
