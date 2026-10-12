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
  assert.deepEqual(fresh.map((d) => `${d.header}:${d.label}`), ['7E5:P1AB0-00']);

  const ch = didChanges(diag.report.monitor);
  assert.ok(ch.some((c) => c.key === '7E5:22B001' && c.index === 3 && c.before === 0 && c.after === 0x35));

  const v = computeVerdict(diag.report);
  assert.equal(v.level, 'alert');
  assert.ok(v.items.some((i) => i.title.startsWith('Nouveau code P1AB0-00 sur 7E5')));

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
