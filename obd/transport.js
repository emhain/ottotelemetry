// Transports OBD — abstraction commune (connect / sendCommand / disconnect).
// Deux implémentations :
//  - WebBluetoothTransport : liaison réelle avec l'OBDLink CX (BLE, UUID FFF0/FFF1/FFF2).
//  - FakeTransport         : réponses simulées, pour développer/tester l'UI sans matériel.
//
// Protocole ELM327/STN : on écrit une commande terminée par '\r' sur FFF2 ; les réponses
// arrivent en notifications sur FFF1 et se terminent par le prompt '>'.
// Voir docs/12-obdlink-cx-ble.md.

const CX_SERVICE = 0xFFF0;
const CX_WRITE = 0xFFF2;   // écriture des commandes
const CX_NOTIFY = 0xFFF1;  // réception des réponses
const DEVICE_INFO = 0x180a;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Liaison réelle Bluetooth Low Energy avec l'OBDLink CX. */
export class WebBluetoothTransport {
  constructor() {
    this.device = null;
    this.server = null;
    this._write = null;
    this._notify = null;
    this._pending = null; // { resolve, reject, buf, timer }
    this._onDisconnect = null;
  }

  get label() {
    return this.device?.name ? `${this.device.name}` : 'OBDLink CX';
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  onDisconnect(cb) {
    this._onDisconnect = cb;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth n'est pas supporté par ce navigateur (utilise Chrome sur Android).");
    }
    // acceptAllDevices : robuste pour un premier test (le CX apparaît même s'il n'annonce
    // pas son service dans l'advertising). On pourra resserrer le filtre plus tard.
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [CX_SERVICE, DEVICE_INFO],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this._pending?.reject?.(new Error('déconnecté'));
      this._pending = null;
      this._onDisconnect?.();
    });

    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(CX_SERVICE);
    this._write = await svc.getCharacteristic(CX_WRITE);
    this._notify = await svc.getCharacteristic(CX_NOTIFY);
    await this._notify.startNotifications();
    this._notify.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e));
  }

  _onNotify(event) {
    const p = this._pending;
    if (!p) return; // notification hors requête : ignorée
    p.buf += new TextDecoder().decode(event.target.value);
    if (p.buf.includes('>')) {
      // prompt '>' = réponse complète.
      p.resolve(cleanup(p.buf.slice(0, p.buf.indexOf('>'))));
    } else {
      p.arm(); // des trames arrivent encore : on repousse le délai d'inactivité
    }
  }

  /**
   * Envoie une commande et attend la réponse complète (jusqu'au prompt '>').
   * Timeout ADAPTATIF : large pour le 1er octet (détection de protocole / « SEARCHING… »),
   * puis basé sur l'inactivité — tant que des trames arrivent, on ne coupe pas la réponse.
   */
  async sendCommand(cmd, { firstByteMs = 8000, inactivityMs = 3000 } = {}) {
    if (!this.connected) throw new Error('non connecté');
    if (this._pending) throw new Error('une commande est déjà en cours');
    const payload = new TextEncoder().encode(cmd.trim() + '\r');
    return new Promise((resolve, reject) => {
      let timer;
      const settle = (fn, arg) => {
        clearTimeout(timer);
        if (this._pending) { this._pending = null; fn(arg); }
      };
      this._pending = {
        buf: '',
        arm: (ms = inactivityMs) => {
          clearTimeout(timer);
          timer = setTimeout(() => settle(reject, new Error('délai dépassé (pas de réponse)')), ms);
        },
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
      };
      this._pending.arm(firstByteMs);
      this._write.writeValueWithResponse(payload).catch((err) => this._pending?.reject(err));
    });
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}

/** Transport simulé : mêmes méthodes, réponses canned. Sert à tester l'UI sans voiture. */
export class FakeTransport {
  constructor() {
    this._connected = false;
  }

  get label() {
    return 'OBDLink CX (simulé)';
  }

  get connected() {
    return this._connected;
  }

  onDisconnect() {}

  async connect() {
    await delay(300);
    this._connected = true;
  }

  async sendCommand(cmd) {
    await delay(120);
    const c = cmd.trim().toUpperCase().replace(/\s+/g, '');
    const table = {
      ATZ: 'ELM327 v1.4b',
      ATI: 'ELM327 v1.4b',
      ATE0: 'OK',
      ATL0: 'OK',
      ATS0: 'OK',
      ATH1: 'OK',
      ATSP0: 'OK',
      ATSP6: 'OK',
      ATSH7E4: 'OK',
      ATDP: 'AUTO, ISO 15765-4 (CAN 11/500)',
      '0100': '7EC 41 00 80 00 00 00',
      // Trames ISO-TP bien formées et réalistes (scénario charge : ~-30 A, 700 V, 25 °C).
      '220101':
        '7EC 10 18 62 01 01 00 00 00\n7EC 21 00 00 00 00 00 00 00\n' +
        '7EC 22 FE D4 1B 58 19 19 19\n7EC 23 19 18 19 19 AA AA AA',
      // SOC affiché 75 %, SOH 98 %.
      '220105':
        '7EC 10 2E 62 01 05 00 00 00\n7EC 21 00 00 00 00 00 00 00\n' +
        '7EC 22 00 00 00 00 00 00 00\n7EC 23 00 00 00 00 00 00 00\n' +
        '7EC 24 00 03 D4 00 00 00 00\n7EC 25 96 00 00 00 00 00 00\n' +
        '7EC 26 00 00 00 00 00 AA AA',
    };
    return table[c] ?? 'NO DATA';
  }

  async disconnect() {
    this._connected = false;
  }
}

/** Nettoyage d'affichage : \r -> \n, suppression des lignes vides superflues. */
function cleanup(raw) {
  return raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}
