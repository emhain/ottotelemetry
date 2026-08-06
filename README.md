# AutoTelemetry — Collecteur (PWA)

Application web (PWA) de collecte de télémétrie OBD-II pour véhicules électriques —
première cible **Hyundai Ioniq 5** via adaptateur **OBDLink CX** (Bluetooth Low Energy, Web Bluetooth).

Elle se connecte à l'adaptateur, interroge le calculateur batterie (BMS), décode
SOC / SOH / tension / courant / puissance / températures, et enregistre des sessions
au format **Replay** (JSON Lines).

- Déploiement : **GitHub Pages** (auto-déploiement à chaque push).
- Navigateur requis : **Chrome sur Android** (Web Bluetooth).
- Aucune donnée n'est envoyée à un serveur : tout reste local sur l'appareil, export manuel.
