// Tests du diagnostic de recharge — lancer depuis webapp/ : node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand, parseUdsResponse, decodeUdsDtcs, formatDtcCode, dtcStatusText } from '../obd/uds.js';
import { decodeDtc } from '../obd/decoder.js';
import { ChargeDiagnostic, computeVerdict, didChanges, newDtcs, SCAN_HEADERS } from '../diag/charge-diag.js';
import { FakeTransport } from '../obd/transport.js';

test('garde lecture seule : lectures acceptées', () => {
  for (const c of ['ATZ', 'ATSH7E5', 'AT SP 6', '03', '07', '0A', '1902FF', '19020D', '220101', '22B001', '22 c0 0b']) {
    assert.ok(isReadOnlyCommand(c), c);
  }
});

test('garde lecture seule : écritures et effacements refusés', () => {
  for (const c of ['04', '14FFFFFF', '1003', '1101', '2EF190AA', '31010203', '2F0101', '3E00', '27 01', '190A', '22B0', '']) {
    assert.equal(isReadOnlyCommand(c), false, c);
  }
});

test('parseUdsResponse : positive, négative, absente, réponse en attente ignorée', () => {
  assert.deepEqual(parseUdsResponse('NO DATA'), { status: 'none', bytes: [] });
  const neg = parseUdsResponse('7ED 03 7F 22 31');
  assert.equal(neg.status, 'negative');
  assert.equal(neg.nrc, 0x31);
  assert.equal(neg.responder, '7ED');
  const pos = parseUdsResponse('7ED 03 7F 19 78\n7ED 07 59 02 FF 1A B0 00 09');
  assert.equal(pos.status, 'positive');
  assert.deepEqual(pos.bytes, [0x59, 0x02, 0xff, 0x1a, 0xb0, 0x00, 0x09]);
});

test('parseUdsResponse : multi-trames ISO-TP', () => {
  const r = parseUdsResponse('7ED 10 0B 59 02 FF 1A B0 00\n7ED 21 09 C1 23 45 2F AA AA');
  assert.equal(r.status, 'positive');
  const d = decodeUdsDtcs(r.bytes);
  assert.equal(d.length, 2);
  assert.equal(d[0].code, 'P1AB0');
  assert.equal(d[1].code, 'U0123');
  assert.equal(d[1].ftb, '45');
});

test('decodeUdsDtcs : statut nul ignoré, libellés de statut', () => {
  assert.deepEqual(decodeUdsDtcs([0x59, 0x02, 0xff]), []);
  assert.deepEqual(decodeUdsDtcs([0x59, 0x02, 0xff, 0x01, 0x02, 0x03, 0x00]), []);
  assert.equal(decodeUdsDtcs([0x62, 0x01]), null);
  assert.equal(formatDtcCode(0xc1, 0x23), 'U0123');
  assert.equal(dtcStatusText(0x09), 'actif, confirmé');
  assert.equal(dtcStatusText(0x40), 'historique');
});

test('decodeDtc : modes 03 (défaut) et 07 (octet de réponse paramétrable)', () => {
  assert.deepEqual(decodeDtc('7EC 04 43 01 01 23'), { count: 1, codes: ['P0123'] });
  assert.deepEqual(decodeDtc('7EC 04 47 01 01 23', 0x47), { count: 1, codes: ['P0123'] });
  assert.deepEqual(decodeDtc('7EC 04 47 01 01 23'), { count: 0, codes: [] });
});

test("scan : n'émet jamais sur une adresse de réponse ni sur 7DF", () => {
  for (const h of SCAN_HEADERS) {
    assert.ok(parseInt(h, 16) % 16 < 8, h);
    assert.notEqual(parseInt(h, 16) + 8, 0x7df, h);
  }
});

test('parcours complet A → B → C sur transport simulé', async () => {
  const t = new FakeTransport();
  await t.connect();
  const diag = new ChargeDiagnostic(t);
  const sent = [];
  const orig = t.sendCommand.bind(t);
  t.sendCommand = (c) => { sent.push(c); return orig(c); };

  const ref = await diag.stepReference();
  assert.deepEqual(diag.report.ecus.map((e) => e.header).sort(), ['7A0', '7B3', '7C6', '7D1', '7E4', '7E5']);
  assert.deepEqual(diag.report.chargeTargets, ['7E5']);
  assert.deepEqual(diag.report.supportedDids['7E5'], ['220101', '22B001']);
  assert.equal(ref.bms.aux12vV != null, true);

  const run = diag.runMonitor({ intervalMs: 0 });
  await new Promise((r) => setTimeout(r, 1500));
  diag.addMarker('Câble branché');
  t.simulate('plug');
  await new Promise((r) => setTimeout(r, 1500));
  diag.stopMonitor();
  await run;
  assert.ok(diag.report.monitor.samples.length >= 2);

  await diag.stepAfter();
  const fresh = newDtcs(diag.report.ref, diag.report.after);
  assert.deepEqual(fresh.map((d) => `${d.header}:${d.fullCode}`), ['7E5:P1E0C73']);

  const ch = didChanges(diag.report.monitor);
  assert.ok(ch.some((c) => c.key === '7E5:22B001' && c.index === 3 && c.before === 0 && c.after === 0x35));

  const v = computeVerdict(diag.report);
  assert.equal(v.level, 'alert');
  const item = v.items.find((i) => i.title.startsWith('Nouveau code P1E0C73 sur 7E5'));
  assert.ok(item);
  assert.match(item.detail, /Input Relay Stuck Closed Check.*26-EV-004H/);
  assert.equal(diag.report.monitor.stopReason, 'manual');

  // Invariant : aucune commande hors liste blanche n'a été émise.
  assert.deepEqual(sent.filter((c) => !isReadOnlyCommand(c)), []);
});

test('la garde bloque avant envoi', async () => {
  const t = new FakeTransport();
  await t.connect();
  let called = false;
  t.sendCommand = async () => { called = true; return 'OK'; };
  const diag = new ChargeDiagnostic(t);
  await assert.rejects(diag.send('14FFFFFF'), /lecture seule/);
  assert.equal(called, false);
});

test('verdict : 12 V faible → alerte ICCU ; charge démarrée → ok', () => {
  const low = computeVerdict({ ref: { bms: { aux12vV: 12.3 }, byEcu: {} }, monitor: { samples: [], markers: [] }, ecus: [] });
  assert.equal(low.level, 'alert');
  assert.match(low.items[0].title, /12 V faible/);

  const mk = (amps, v12) => amps.map((a, i) => ({ t: `2026-10-12T10:00:0${i}Z`, bms: { currentA: a, aux12vV: v12[i] }, raw: {} }));
  const markers = [{ t: '2026-10-12T10:00:01Z', label: 'Câble branché' }];
  const base = { ref: { bms: { aux12vV: 13.5 }, byEcu: {} }, ecus: [{ header: '7E5' }] };

  const ok = computeVerdict({ ...base, monitor: { samples: mk([0, -15, -16, -16], [12.4, 14, 14, 14]), markers } });
  assert.ok(ok.items.some((i) => i.title === 'La charge a démarré après le branchement'));
  assert.ok(ok.items.some((i) => i.title.startsWith('12 V au branchement : en hausse')));

  const refused = computeVerdict({ ...base, monitor: { samples: mk([0, 0.5, 0.4, 0.5], [12.4, 12.4, 12.5, 12.4]), markers } });
  assert.ok(refused.items.some((i) => i.title === 'Aucun courant de charge après le branchement'));
  assert.ok(refused.items.some((i) => i.title.startsWith('12 V au branchement : stable')));

  // Courant déjà négatif avant le repère, 12 V déjà maintenue (Ready) : non concluant.
  const ready = computeVerdict({ ...base, monitor: { samples: mk([-30, -30, -30, -30], [14.2, 14.2, 14.2, 14.2]), markers } });
  assert.ok(ready.items.some((i) => i.title === 'Courant déjà négatif avant le branchement'));
  assert.ok(ready.items.some((i) => i.title.startsWith('12 V déjà maintenue')));
});

test('dictionnaire : codes du bulletin ICCU relevés sur la voiture', async () => {
  const { describeDtc, dtcFullCode, asciiDid } = await import('../obd/uds.js');
  // Trame réelle du 12/10/2026 (7E5) : P1E011C + P1E0C73.
  const r = parseUdsResponse('7ED 10 0B 59 02 FF 1E 01 1C\n7ED 21 2C 1E 0C 73 28 AA AA');
  const d = decodeUdsDtcs(r.bytes);
  assert.deepEqual(d.map(dtcFullCode), ['P1E011C', 'P1E0C73']);
  assert.match(describeDtc(d[0]).text, /PFC Voltage Sensor/);
  assert.equal(describeDtc({ code: 'P0123', ftb: '00' }), null);
  assert.equal(asciiDid([0x62, 0xf1, 0x89, 0x31, 0x2e, 0x30, 0x32]), '1.02');
});

test('réponse 19 02 tronquée (« 7CE 01 59 ») = partielle, pas « aucun code »', async () => {
  const t = new FakeTransport(); await t.connect();
  t.sendCommand = async (c) => (c === '1902FF' ? '7CE 01 59' : 'OK');
  const r = await new ChargeDiagnostic(t).readUdsDtcs('7C6');
  assert.equal(r.status, 'partial');
});

test('reconnexion : attach() garde le rapport ; arrêt automatique après le repère', async () => {
  const t1 = new FakeTransport(); await t1.connect();
  const diag = new ChargeDiagnostic(t1);
  diag.report.ref = { byEcu: {} };
  diag.report.monitor.markers.push({ t: new Date(Date.now() - 1000).toISOString(), label: 'Câble branché' });
  await diag.runMonitor({ intervalMs: 0, afterMarkerMs: 500 });
  assert.equal(diag.report.monitor.stopReason, 'auto');

  const t2 = new FakeTransport(); await t2.connect();
  diag.attach(t2);
  assert.equal(diag.t, t2);
  assert.ok(diag.report.ref);
  assert.equal(diag.report.monitor.markers.length, 1);
});
