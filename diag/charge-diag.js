// Diagnostic de recharge AC (Ioniq 5 / E-GMP) — moteur, sans UI.
//
// Procédure (voir docs/14-diagnostic-recharge.md) :
//   A. Référence  : voiture en Ready, débranchée → scan des calculateurs, codes défaut
//                   (génériques + constructeur), état batterie/12 V, sondage des DID des
//                   calculateurs « charge » candidats.
//   B. Branchement : surveillance continue (BMS + DID bruts) pendant qu'on branche la borne,
//                   avec repères horodatés (« câble branché », « voyants éteints »).
//   C. Après échec : relecture des codes défaut → nouveaux codes apparus pendant la tentative.
// Puis verdict automatique (computeVerdict) et rapport JSON exportable.
//
// LECTURE SEULE (ADR-005) : toutes les commandes passent par isReadOnlyCommand().

import { reassembleIsoTp, decode0101, decode0105, decodeDtc } from '../obd/decoder.js';
import { isReadOnlyCommand, parseUdsResponse, decodeUdsDtcs, dtcLabel, nrcText, toHex } from '../obd/uds.js';

export const REPORT_VERSION = 1;

// Calculateurs connus. `confirmed` = adresse validée sur la voiture (docs/10-signals.md) ;
// les autres viennent des profils communautaires E-GMP et restent à confirmer.
// `charge` = candidat pour la chaîne de recharge AC (sondé et surveillé).
export const KNOWN_ECUS = {
  '7E4': { name: 'Batterie (BMS)', confirmed: true },
  '7C6': { name: "Combiné d'instruments", confirmed: true },
  '7A0': { name: 'Carrosserie / pneus (BCM)', confirmed: true },
  '7B3': { name: 'Climatisation', confirmed: true },
  '7E2': { name: 'Gestion véhicule (VCU)', charge: true },
  '7E3': { name: 'Onduleur moteur (MCU)' },
  '7E5': { name: 'Charge (OBC / VCMS)', charge: true },
  '770': { name: 'Boîtier habitacle (IGPM)' },
  '7D1': { name: 'Freinage (ESC)' },
  '7D2': { name: 'Airbags' },
  '7D4': { name: 'Direction (MDPS)' },
};

// Adresses à scanner : familles x0–x7 uniquement (les réponses arrivent en x8–xF), ce qui
// évite d'émettre sur l'identifiant de réponse d'un autre calculateur. 7D7 est exclu : sa
// réponse partirait sur 7DF, l'adresse de diffusion OBD.
export const SCAN_HEADERS = ['7E', '7D', '7C', '7B', '7A', '77']
  .flatMap((f) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${f}${i}`))
  .filter((h) => h !== '7D7');

// DID sondés sur les calculateurs « charge » : blocs usuels Hyundai/Kia (0101–010A, B001–B00A,
// C001–C00A). Un DID non supporté répond 7F 22 31 : sans effet.
export const PROBE_DIDS = [
  ...[...Array(10)].map((_, i) => `2201${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`),
  ...[...Array(10)].map((_, i) => `22B0${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`),
  ...[...Array(10)].map((_, i) => `22C0${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`),
];

const INIT = ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATSP6'];
const ecuName = (h) => KNOWN_ECUS[h]?.name ?? 'Calculateur inconnu';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class ChargeDiagnostic {
  /**
   * @param transport  transport OBD (sendCommand / connected)
   * @param opts.log   (kind, msg) → journal
   * @param opts.onUpdate () → rafraîchir l'UI
   */
  constructor(transport, { log = () => {}, onUpdate = () => {} } = {}) {
    this.t = transport;
    this.log = log;
    this.onUpdate = onUpdate;
    this.monitoring = false;
    this.report = {
      type: 'charge-diagnostic',
      version: REPORT_VERSION,
      vehicleId: 'ioniq5',
      startedAt: new Date().toISOString(),
      ecus: [],          // [{ header, name, responder, dtcStatus, nrc? }]
      chargeTargets: [], // en-têtes des calculateurs surveillés
      supportedDids: {}, // { header: [did, …] }
      ref: null,         // étape A
      monitor: { startedAt: null, stoppedAt: null, markers: [], samples: [] },
      after: null,       // étape C
      raw: [],           // [{ t, cmd, resp }] toutes les requêtes/réponses
    };
    this._header = null;
  }

  // --- Bas niveau ---
  async send(cmd) {
    if (!isReadOnlyCommand(cmd)) throw new Error(`commande refusée (lecture seule) : ${cmd}`);
    if (!this.t?.connected) throw new Error('non connecté');
    const resp = await this.t.sendCommand(cmd);
    this.report.raw.push({ t: new Date().toISOString(), cmd, resp });
    return resp;
  }

  async setHeader(h) {
    if (this._header === h) return;
    await this.send(`ATSH${h}`);
    this._header = h;
  }

  async init() {
    for (const c of INIT) await this.send(c);
    this._header = null;
  }

  // --- Lectures ---
  /** Lit les DTC constructeur d'un calculateur (19 02 FF, repli sur masque 0D). */
  async readUdsDtcs(header) {
    await this.setHeader(header);
    let r = parseUdsResponse(await this.send('1902FF'));
    if (r.status === 'negative' && (r.nrc === 0x31 || r.nrc === 0x12)) {
      r = parseUdsResponse(await this.send('19020D'));
    }
    if (r.status === 'none') return { status: 'none', responder: null };
    if (r.status === 'negative') return { status: 'negative', nrc: r.nrc, nrcText: nrcText(r.nrc), responder: r.responder };
    const dtcs = decodeUdsDtcs(r.bytes);
    return dtcs ? { status: 'ok', dtcs, responder: r.responder } : { status: 'invalid', raw: toHex(r.bytes), responder: r.responder };
  }

  async readGenericDtcs() {
    await this.setHeader('7DF');
    const out = {};
    for (const [mode, key, byte] of [['03', 'confirmed', 0x43], ['07', 'pending', 0x47], ['0A', 'permanent', 0x4a]]) {
      try { out[key] = decodeDtc(await this.send(mode), byte).codes; } catch { out[key] = null; }
    }
    return out;
  }

  async readBms() {
    await this.setHeader('7E4');
    const d1 = decode0101(reassembleIsoTp(await this.send('220101')));
    const d5 = decode0105(reassembleIsoTp(await this.send('220105')));
    return {
      socDisplayPct: d5?.socDisplayPct ?? null,
      socBmsPct: d1?.socBmsPct ?? null,
      currentA: d1?.currentA ?? null,
      voltageV: d1?.voltageV ?? null,
      powerKw: d1?.powerKw ?? null,
      aux12vV: d1?.aux12vV ?? null,
      tempMinC: d1?.tempMinC ?? null,
      tempMaxC: d1?.tempMaxC ?? null,
      energyChargedKwh: d1?.energyChargedKwh ?? null,
    };
  }

  /** Scanne les calculateurs présents (réponse quelconque à 19 02). */
  async scanEcus(onProgress = () => {}) {
    const found = [];
    for (let i = 0; i < SCAN_HEADERS.length; i++) {
      const h = SCAN_HEADERS[i];
      onProgress(i + 1, SCAN_HEADERS.length, h);
      try {
        const r = await this.readUdsDtcs(h);
        if (r.status !== 'none') {
          found.push({ header: h, name: ecuName(h), ...r });
          this.log('info', `Calculateur ${h} (${ecuName(h)}) : ${r.status === 'ok' ? `${r.dtcs.length} code(s)` : r.nrcText ?? r.status}`);
        }
      } catch (e) {
        if (!this.t.connected) throw e;
      }
    }
    return found;
  }

  /** Lit les DTC constructeur de tous les calculateurs déjà identifiés. */
  async readAllUdsDtcs() {
    const byEcu = {};
    for (const e of this.report.ecus) {
      try { byEcu[e.header] = await this.readUdsDtcs(e.header); } catch (err) {
        if (!this.t.connected) throw err;
        byEcu[e.header] = { status: 'error', error: String(err?.message ?? err) };
      }
    }
    return byEcu;
  }

  /** Sonde les DID d'un calculateur ; retourne { did: hex } des réponses positives. */
  async probeDids(header) {
    await this.setHeader(header);
    const ok = {};
    for (const did of PROBE_DIDS) {
      const r = parseUdsResponse(await this.send(did));
      if (r.status === 'positive' && r.bytes[0] === 0x62) ok[did] = toHex(r.bytes);
    }
    return ok;
  }

  // --- Étapes ---
  async stepReference(onProgress = () => {}) {
    await this.init();
    onProgress('Scan des calculateurs…');
    const ecus = await this.scanEcus((i, n, h) => onProgress(`Scan des calculateurs ${i}/${n} (${h})…`));
    this.report.ecus = ecus;
    this.report.chargeTargets = ecus
      .filter((e) => KNOWN_ECUS[e.header]?.charge || (!KNOWN_ECUS[e.header] && e.header.startsWith('7E')))
      .map((e) => e.header);

    onProgress('Codes défaut génériques…');
    const generic = await this.readGenericDtcs();
    onProgress('Batterie et 12 V…');
    const bms = await this.readBms().catch(() => null);

    const dids = {};
    for (const h of this.report.chargeTargets) {
      onProgress(`Sondage des données du calculateur ${h}…`);
      dids[h] = await this.probeDids(h);
      this.report.supportedDids[h] = Object.keys(dids[h]);
      this.log('info', `${h} : ${this.report.supportedDids[h].length} DID lisible(s)`);
    }
    const byEcu = Object.fromEntries(ecus.map((e) => [e.header, e]));
    this.report.ref = { t: new Date().toISOString(), generic, byEcu, bms, dids };
    this.onUpdate();
    return this.report.ref;
  }

  addMarker(label) {
    const m = { t: new Date().toISOString(), label };
    this.report.monitor.markers.push(m);
    this.log('info', `Repère : ${label}`);
    this.onUpdate();
    return m;
  }

  /** Surveillance continue jusqu'à stopMonitor(). Tolère les « NO DATA » (calculateurs endormis). */
  async runMonitor({ intervalMs = 400 } = {}) {
    if (this.monitoring) return;
    const mon = this.report.monitor;
    mon.startedAt = new Date().toISOString();
    mon.stoppedAt = null;
    this.monitoring = true;
    this.onUpdate();
    try {
      while (this.monitoring && this.t.connected) {
        // rawAt : instant de CHAQUE lecture (un cycle dure ~1 s : le dater d'un bloc décalerait
        // les octets par rapport au repère « câble branché »).
        const sample = { t: new Date().toISOString(), bms: null, raw: {}, rawAt: {} };
        try { sample.bms = await this.readBms(); } catch (e) { if (!this.t.connected) throw e; }
        for (const h of this.report.chargeTargets) {
          for (const did of this.report.supportedDids[h] ?? []) {
            if (!this.monitoring) break;
            try {
              await this.setHeader(h);
              const r = parseUdsResponse(await this.send(did));
              sample.raw[`${h}:${did}`] = r.status === 'positive' ? toHex(r.bytes)
                : r.status === 'negative' ? `NRC ${nrcText(r.nrc)}` : null;
              sample.rawAt[`${h}:${did}`] = new Date().toISOString();
            } catch (e) { if (!this.t.connected) throw e; }
          }
        }
        mon.samples.push(sample);
        this.onUpdate();
        await delay(intervalMs);
      }
    } finally {
      this.monitoring = false;
      mon.stoppedAt = new Date().toISOString();
      this.onUpdate();
    }
  }

  stopMonitor() { this.monitoring = false; }

  async stepAfter(onProgress = () => {}) {
    onProgress('Codes défaut génériques…');
    const generic = await this.readGenericDtcs();
    onProgress('Codes défaut constructeur…');
    const byEcu = await this.readAllUdsDtcs();
    const bms = await this.readBms().catch(() => null);
    this.report.after = { t: new Date().toISOString(), generic, byEcu, bms };
    this.onUpdate();
    return this.report.after;
  }
}

// ---------------------------------------------------------------------------
// Analyse (fonctions pures, testées)
// ---------------------------------------------------------------------------

/** Liste à plat des DTC constructeur d'une lecture { byEcu } : [{ header, name, label, statusText }]. */
export function flattenDtcs(reading) {
  const out = [];
  for (const [header, r] of Object.entries(reading?.byEcu ?? {})) {
    for (const d of r?.dtcs ?? []) out.push({ header, name: ecuName(header), label: dtcLabel(d), statusText: d.statusText });
  }
  return out;
}

/** DTC présents après la tentative et absents de la référence (même calculateur, même code). */
export function newDtcs(ref, after) {
  const before = new Set(flattenDtcs(ref).map((d) => `${d.header}:${d.label}`));
  const fresh = flattenDtcs(after).filter((d) => !before.has(`${d.header}:${d.label}`));
  const g0 = new Set([...(ref?.generic?.confirmed ?? []), ...(ref?.generic?.pending ?? [])]);
  for (const c of [...(after?.generic?.confirmed ?? []), ...(after?.generic?.pending ?? [])]) {
    if (!g0.has(c)) fresh.push({ header: '7DF', name: 'OBD générique', label: c, statusText: '' });
  }
  return fresh;
}

/**
 * Octets des DID bruts qui ont changé pendant la surveillance, avec leur valeur avant et après
 * le premier repère (« câble branché »). Sert à repérer signal pilote, tension AC, état OBC…
 */
export function didChanges(monitor) {
  const samples = monitor?.samples ?? [];
  const marker = monitor?.markers?.[0]?.t ?? null;
  const series = {};
  for (const s of samples) {
    for (const [key, val] of Object.entries(s.raw ?? {})) {
      if (!val || val.startsWith('NRC')) continue;
      (series[key] ??= []).push({ t: s.rawAt?.[key] ?? s.t, b: val.split(' ').map((h) => parseInt(h, 16)) });
    }
  }
  const changes = [];
  for (const [key, pts] of Object.entries(series)) {
    const len = Math.max(...pts.map((p) => p.b.length));
    for (let i = 0; i < len; i++) {
      const vals = pts.map((p) => p.b[i]).filter((v) => v != null);
      if (new Set(vals).size <= 1) continue;
      const pre = pts.filter((p) => !marker || p.t < marker).map((p) => p.b[i]).filter((v) => v != null);
      const post = pts.filter((p) => marker && p.t >= marker).map((p) => p.b[i]).filter((v) => v != null);
      changes.push({
        key, index: i,
        distinct: new Set(vals).size,
        before: pre.length ? pre[pre.length - 1] : null,
        after: post.length ? post[post.length - 1] : null,
        min: Math.min(...vals), max: Math.max(...vals),
      });
    }
  }
  return changes;
}

/**
 * Verdict à partir du rapport. Chaque constat : { level: 'ok'|'warn'|'alert'|'info', title, detail }.
 * Les seuils reprennent la grille d'interprétation de docs/14-diagnostic-recharge.md.
 */
export function computeVerdict(report) {
  const items = [];
  const ref = report?.ref;
  const bms = ref?.bms;

  // 12 V en Ready = convertisseur DC/DC de l'ICCU.
  if (bms?.aux12vV != null) {
    if (bms.aux12vV < 13.0) {
      items.push({ level: 'alert', title: `12 V faible en Ready (${bms.aux12vV} V)`,
        detail: "Le convertisseur 12 V de l'ICCU ne recharge pas la batterie 12 V. Risque de panne : concession rapidement (rappel ICCU)." });
    } else {
      items.push({ level: 'ok', title: `12 V correcte en Ready (${bms.aux12vV} V)`,
        detail: "Le convertisseur 12 V de l'ICCU fonctionne. Cela n'innocente pas l'étage chargeur (OBC) du même boîtier." });
    }
  }

  if (bms?.socDisplayPct != null && bms.socDisplayPct >= 90) {
    items.push({ level: 'warn', title: `SOC élevé (${bms.socDisplayPct} %)`,
      detail: 'Vérifiez que la limite de charge AC du véhicule est au-dessus du SOC actuel.' });
  }

  // Codes constructeur présents dès la référence.
  const refDtcs = flattenDtcs(ref);
  const chargeHeaders = new Set(report?.chargeTargets ?? []);
  for (const d of refDtcs) {
    const onCharge = chargeHeaders.has(d.header);
    items.push({ level: onCharge ? 'alert' : 'info', title: `${d.label} sur ${d.header} (${d.name})`,
      detail: `${d.statusText}${onCharge ? ' — calculateur de la chaîne de charge.' : ''}` });
  }
  for (const c of ref?.generic?.confirmed ?? []) items.push({ level: 'info', title: `Code générique ${c}`, detail: 'Lu en mode 03.' });

  // Surveillance : la charge a-t-elle démarré APRÈS le repère « câble branché » ?
  const samples = report?.monitor?.samples ?? [];
  const marker = report?.monitor?.markers?.[0]?.t ?? null;
  if (samples.length && marker) {
    const pick = (list, f) => list.map(f).filter((v) => v != null);
    const preS = samples.filter((s) => s.t < marker);
    const postS = samples.filter((s) => s.t >= marker);
    const preA = pick(preS, (s) => s.bms?.currentA);
    const postA = pick(postS, (s) => s.bms?.currentA);
    const alreadyNegative = preA.length && preA.filter((a) => a < -3).length > preA.length / 2;
    if (alreadyNegative) {
      items.push({ level: 'info', title: 'Courant déjà négatif avant le branchement',
        detail: 'Impossible de conclure sur le démarrage de la charge : recommencez voiture immobile, câble débranché au départ.' });
    } else if (postA.filter((a) => a < -3).length >= 3) {
      items.push({ level: 'ok', title: 'La charge a démarré après le branchement',
        detail: `Courant jusqu'à ${Math.min(...postA)} A. Le problème ne s'est pas reproduit sur cet essai.` });
    } else {
      items.push({ level: 'warn', title: 'Aucun courant de charge après le branchement',
        detail: postA.length ? 'Le courant batterie est resté proche de 0 A : refus de charge confirmé.'
          : 'La batterie (BMS) ne répondait pas après le branchement : réveillez la voiture et recommencez.' });
    }

    // 12 V : test probant seulement voiture éteinte (en Ready, l'ICCU maintient déjà ~14 V).
    const pre12 = pick(preS, (s) => s.bms?.aux12vV);
    const post12 = pick(postS, (s) => s.bms?.aux12vV);
    if (pre12.length && post12.length) {
      const before = pre12[pre12.length - 1];
      const peak = Math.max(...post12);
      if (before >= 13.2) {
        items.push({ level: 'info', title: `12 V déjà maintenue avant le branchement (${before} V)`,
          detail: "Voiture en Ready : le test d'activation de l'ICCU au branchement n'est pas concluant." });
      } else {
        const rise = peak - before >= 0.5;
        items.push({ level: rise ? 'info' : 'warn', title: `12 V au branchement : ${rise ? 'en hausse' : 'stable'} (${before} → ${peak} V)`,
          detail: rise ? "L'ICCU s'est activé au branchement." : "L'ICCU ne s'est pas activé : la séquence de charge s'arrête avant." });
      }
    }
  } else if (samples.length) {
    items.push({ level: 'info', title: 'Surveillance sans repère « Câble branché »',
      detail: 'Touchez « Câble branché » au moment du branchement pour une analyse avant/après.' });
  }

  // Nouveaux codes apparus pendant la tentative.
  if (report?.after) {
    const fresh = newDtcs(ref, report.after);
    if (fresh.length) {
      for (const d of fresh) {
        items.push({ level: 'alert', title: `Nouveau code ${d.label} sur ${d.header} (${d.name})`,
          detail: `Apparu pendant la tentative de charge. ${d.statusText}` });
      }
    } else {
      items.push({ level: 'info', title: 'Aucun nouveau code défaut après la tentative',
        detail: "Si la charge a échoué quand même, l'arrêt n'est pas journalisé : comparez les octets des DID qui ont changé au branchement." });
    }
  }

  if (!report?.ecus?.some((e) => KNOWN_ECUS[e.header]?.charge)) {
    if (report?.ref) {
      items.push({ level: 'warn', title: 'Calculateur de charge non identifié',
        detail: "Aucune réponse en 7E5 / 7E2. Partagez le rapport : l'adresse du chargeur sera recherchée dans les trames brutes." });
    }
  }

  const rank = { alert: 3, warn: 2, info: 1, ok: 0 };
  items.sort((a, b) => rank[b.level] - rank[a.level]);
  const level = items.reduce((m, i) => (rank[i.level] > rank[m] ? i.level : m), 'ok');
  return { level, items };
}
