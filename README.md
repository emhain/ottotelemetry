# AutoTelemetry — Collecteur (PWA)

Application web (PWA) de collecte de télémétrie OBD-II pour véhicules électriques —
première cible **Hyundai Ioniq 5** via adaptateur **OBDLink CX** (Bluetooth Low Energy, Web Bluetooth).

- **Console OBD** : connexion à l'adaptateur, commandes ELM327, snapshot décodé (batterie, 12 V,
  odomètre, pneus, températures, codes défaut) exportable au format **Replay** (JSON Lines).
- **Enregistrement** : interrogation continue de la batterie (BMS) → fichier Replay `.jsonl`.
- **Diagnostic recharge AC** : procédure guidée (référence → surveillance du branchement →
  relecture des codes) qui lit les codes défaut constructeur de chaque calculateur (UDS `19 02`),
  dont le chargeur de l'ICCU, et produit un verdict + un rapport JSON. Identifie notamment les codes
  du bulletin Hyundai 26-EV-004H (remplacement de l'ICCU).

**Lecture seule** : chaque commande envoyée au véhicule est vérifiée par une liste blanche
(`obd/uds.js`) — aucune écriture, aucun effacement de code défaut.

## Utilisation

- Adresse : **https://ottotelemetry.emmanuel-niel.workers.dev**
- Navigateur requis : **Chrome sur Android** (Web Bluetooth, HTTPS).
- Un seul détenteur Bluetooth à la fois : fermer les autres applications connectées à l'OBDLink.
- **Mode simulation** : rejoue des trames réelles pour essayer l'interface sans voiture.
- Aucune donnée n'est envoyée à un serveur : tout reste sur l'appareil (rapport de diagnostic
  sauvegardé localement), export manuel par téléchargement ou partage.

## Déploiement

**Cloudflare Workers (static assets)**, connecté à ce dépôt : chaque push sur `main` est
redéployé en quelques secondes. `_headers` désactive le cache de `sw.js` et `index.html`
(mises à jour immédiates) ; `.assetsignore` exclut du déploiement `.git`, les tests et ce README.
À chaque publication, incrémenter `BUILD` (`app.js`) et `CACHE` (`sw.js`).

## Tests

```bash
node --test test/diag.test.mjs
```
