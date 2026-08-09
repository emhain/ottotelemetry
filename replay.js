// Format Replay (voir docs/09-replay-format.md).
// Produit un fichier JSON Lines : 1 ligne d'en-tête + 1 ligne par échantillon.
// Ce format est directement relisable par le module core (ReplayTelemetryProvider).

// Construit un échantillon Replay à partir des décodages 220101 (d1) et 220105 (d5).
// Les clés suivent le dictionnaire des signaux (docs/10-signals.md).
export function buildSample(timestampIso, d1, d5, odometerKm) {
  const m = {};
  if (odometerKm != null) m['vehicle.odometer'] = odometerKm;
  if (d5) {
    m['battery.soc'] = d5.socDisplayPct;
    m['battery.soh'] = d5.sohPct;
  }
  if (d1) {
    m['battery.soc_bms'] = d1.socBmsPct;
    m['battery.voltage'] = d1.voltageV;
    m['battery.current'] = d1.currentA;
    m['battery.power'] = d1.powerKw;
    m['battery.cell_v_max'] = d1.cellVMax;
    m['battery.cell_v_min'] = d1.cellVMin;
    m['battery.temp_min'] = d1.tempMinC;
    m['battery.temp_max'] = d1.tempMaxC;
    if (d1.energyChargedKwh != null) {
      // Compteurs cumulés à vie → l'énergie d'une session = delta début/fin (robuste aux trous).
      m['battery.energy_charged_kwh'] = d1.energyChargedKwh;
      m['battery.energy_discharged_kwh'] = d1.energyDischargedKwh;
      m['charge.plugged_ac'] = d1.acPlugged ? 1 : 0;
      m['charge.plugged_dc'] = d1.dcPlugged ? 1 : 0;
    }
  }
  return { type: 'sample', timestamp: timestampIso, measurements: m, events: [] };
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
