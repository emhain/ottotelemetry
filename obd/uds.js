// Briques UDS (ISO 14229) en LECTURE SEULE pour le diagnostic.
// - Garde « passif strict » (ADR-005) : seules les requêtes de lecture passent.
// - Parsing des réponses ELM327 (ATH1) d'un calculateur adressé physiquement (ATSH xxx).
// - Décodage des codes défaut constructeur (service 19 02 = ReadDTCInformation by status mask).
// Fonctions pures, testables sous Node (voir test/uds.test.mjs).

import { reassembleIsoTp } from './decoder.js';

// Liste blanche des commandes autorisées par le diagnostic. Tout le reste est refusé AVANT
// l'envoi : jamais d'effacement de codes (04 / 14), de session (10), d'écriture (2E), de
// routine (31), de reset (11) ni de contrôle d'E/S (2F).
const ALLOWED = [
  /^AT[A-Z0-9 ]+$/,          // configuration de l'adaptateur (n'atteint pas le véhicule)
  /^0[37A]$/,                // OBD : codes confirmés (03), en attente (07), permanents (0A)
  /^1902[0-9A-F]{2}$/,       // UDS : lecture des DTC par masque de statut
  /^22[0-9A-F]{4}$/,         // UDS : lecture d'un identifiant de données (DID)
];

export function isReadOnlyCommand(cmd) {
  const c = String(cmd).trim().toUpperCase().replace(/\s+/g, '');
  return ALLOWED.some((re) => re.test(c));
}

const NRC = {
  0x10: 'refus général',
  0x11: 'service non supporté',
  0x12: 'sous-fonction non supportée',
  0x13: 'longueur incorrecte',
  0x22: 'conditions non remplies',
  0x31: 'hors plage (non supporté)',
  0x33: 'accès sécurisé requis',
  0x78: 'réponse en attente',
  0x7e: 'sous-fonction non supportée dans cette session',
  0x7f: 'service non supporté dans cette session',
};
export const nrcText = (code) => NRC[code] ?? `code 0x${hex(code)}`;

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
export const toHex = (bytes) => bytes.map(hex).join(' ');

/** Octets d'une ligne ELM (« 7ED 10 0B 59 02 … ») sans l'en-tête CAN 3 caractères. */
function lineBytes(line) {
  return line.trim().split(/\s+/).filter((t) => /^[0-9A-Fa-f]{2}$/.test(t)).map((h) => parseInt(h, 16));
}

/**
 * Analyse la réponse brute d'un calculateur à une requête UDS.
 * Retourne { status: 'none' | 'positive' | 'negative', bytes, nrc?, responder? }.
 * Les « réponse en attente » (7F xx 78) sont ignorées : la vraie réponse suit.
 */
export function parseUdsResponse(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let responder = null;
  const kept = [];
  for (const line of lines) {
    const b = lineBytes(line);
    if (!b.length) continue; // NO DATA, CAN ERROR, ?, SEARCHING…
    const sfPending = (b[0] >> 4) === 0 && b[1] === 0x7f && b[3] === 0x78;
    if (sfPending) continue;
    const m = line.match(/^([0-9A-Fa-f]{3})\s/);
    if (m && !responder) responder = m[1].toUpperCase();
    kept.push(line);
  }
  if (!kept.length) return { status: 'none', bytes: [] };
  const bytes = reassembleIsoTp(kept.join('\n'));
  if (bytes[0] === 0x7f) return { status: 'negative', bytes, nrc: bytes[2], responder };
  return { status: 'positive', bytes, responder };
}

/** Code défaut au format SAE (P/C/B/U + 4 caractères) à partir des 2 premiers octets. */
export function formatDtcCode(hi, mid) {
  const letter = ['P', 'C', 'B', 'U'][hi >> 6];
  return letter + ((hi >> 4) & 0x3) + (hi & 0xf).toString(16).toUpperCase()
    + (mid >> 4).toString(16).toUpperCase() + (mid & 0xf).toString(16).toUpperCase();
}

/** Lecture humaine de l'octet de statut d'un DTC UDS. */
export function dtcStatusText(s) {
  const parts = [];
  if (s & 0x01) parts.push('actif');
  if (s & 0x04) parts.push('en attente');
  if (s & 0x08) parts.push('confirmé');
  if (s & 0x80) parts.push('voyant demandé');
  if (!parts.length) parts.push('historique');
  return parts.join(', ');
}

/**
 * Décode une réponse positive à 19 02 : 59 02 <masque dispo> puis enregistrements de 4 octets
 * (DTC haut, DTC milieu, type de défaut, statut). Les enregistrements au statut nul sont ignorés.
 */
export function decodeUdsDtcs(bytes) {
  if (!bytes || bytes[0] !== 0x59 || bytes[1] !== 0x02) return null;
  const dtcs = [];
  for (let i = 3; i + 3 < bytes.length; i += 4) {
    const [hi, mid, ftb, status] = bytes.slice(i, i + 4);
    if (status === 0) continue;
    dtcs.push({
      code: formatDtcCode(hi, mid),
      ftb: hex(ftb),
      status,
      statusText: dtcStatusText(status),
      raw: toHex([hi, mid, ftb, status]),
    });
  }
  return dtcs;
}

/** Libellé lisible d'un DTC (« P1AA6-00 »). */
export const dtcLabel = (d) => `${d.code}-${d.ftb}`;
