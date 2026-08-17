// Format Replay (voir docs/09-replay-format.md).
// Produit un fichier JSON Lines : 1 ligne d'en-tête + 1 ligne par échantillon.
// Ce format est directement relisable par le module core (ReplayTelemetryProvider).

// Construit un échantillon Replay à partir des décodages 220101 (d1) et 220105 (d5).
// Les clés suivent le dictionnaire des signaux (docs/10-signals.md).
export function buildSample(timestampIso, d1, d5, extra = {}) {
  const m = {};
  if (extra.odometerKm != null) m['vehicle.odometer'] = extra.odometerKm;
  if (extra.speedKmh != null) m['vehicle.speed'] = extra.speedKmh;
  if (extra.tempOutdoorC != null) m['env.temp_outdoor'] = +extra.tempOutdoorC.toFixed(1);
  if (extra.tempIndoorC != null) m['env.temp_indoor'] = +extra.tempIndoorC.toFixed(1);
  if (extra.tpms) {
    const t = extra.tpms;
    m['tire.fl_bar'] = t.fl.bar; m['tire.fr_bar'] = t.fr.bar;
    m['tire.bl_bar'] = t.bl.bar; m['tire.br_bar'] = t.br.bar;
    m['tire.fl_temp'] = t.fl.tempC; m['tire.fr_temp'] = t.fr.tempC;
    m['tire.bl_temp'] = t.bl.tempC; m['tire.br_temp'] = t.br.tempC;
  }
  if (extra.pos) { m['position.lat'] = extra.pos.lat; m['position.lon'] = extra.pos.lon; }
  if (d5) {
    m['battery.soc'] = d5.socDisplayPct;
    m['battery.soh'] = d5.sohPct;
  }
  if (d1) {
    m['battery.soc_bms'] = d1.socBmsPct;
    m['battery.voltage'] = d1.voltageV;
    m['battery.current'] = d1.currentA;
    m['battery.power'] = d1.powerKw;
    if (d1.aux12vV != null) m['aux.voltage_12v'] = d1.aux12vV;
    m['battery.cell_v_max'] = d1.cellVMax;
    m['battery.cell_v_min'] = d1.cellVMin;
    if (d1.cellDeltaMv != null) m['battery.cell_delta_mv'] = d1.cellDeltaMv;
    m['battery.temp_min'] = d1.tempMinC;
    m['battery.temp_max'] = d1.tempMaxC;
    if (d1.energyChargedKwh != null) {
      // Compteurs cumulés à vie → l'énergie d'une session = delta début/fin (robuste aux trous).
      m['battery.energy_charged_kwh'] = d1.energyChargedKwh;
      m['battery.energy_discharged_kwh'] = d1.energyDischargedKwh;
      m['battery.charged_ah'] = d1.chargedAh; // throughput (dégradation batterie)
      m['battery.discharged_ah'] = d1.dischargedAh;
      m['charge.plugged_ac'] = d1.acPlugged ? 1 : 0;
      m['charge.plugged_dc'] = d1.dcPlugged ? 1 : 0;
    }
  }
  const events = [];
  if (extra.dtc) {
    m['dtc.count'] = extra.dtc.count;
    if (extra.dtc.codes?.length) events.push(...extra.dtc.codes.map((c) => `DTC:${c}`));
  }
  return { type: 'sample', timestamp: timestampIso, measurements: m, events };
}

// Sérialise l'en-tête + les échantillons en JSON Lines.
export function buildReplayJsonl(meta, samples) {
  const header = {
    type: 'header',
    schemaVersion: 1,
    sessionId: meta.sessionId,
    vehicleId: meta.vehicleId,
    kind: meta.kind,
  };
  return [JSON.stringify(header), ...samples.map((s) => JSON.stringify(s))].join('\n');
}
