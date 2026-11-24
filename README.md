# Le Mur

Livre d'or vivant pour soirées : les invités scannent un QR code, prennent un selfie,
dessinent, ajoutent des emojis et des mots. Tout apparaît en direct sur un mur partagé
et sur un écran de projection. Aucune application à installer, aucun compte.

## Pages

| URL | Rôle |
|---|---|
| `/` | Page invité (prénom + consentement, selfie / galerie / mot, éditeur) |
| `/mur` | Le mur en direct (réactions, suppression de ses propres posts) |
| `/projection` | Mode TV plein écran (clic ou touche F), QR code intégré |
| `/admin` | Modération, export zip, QR à imprimer (clé `ADMIN_KEY`) |
| `/qr.svg` | QR code d'invitation (contient le code de soirée) — réservé à l'admin |
| `/healthz` | Test de santé |

## Lancer

```bash
npm ci --omit=dev
PORT=3100 ADMIN_KEY=<clé longue> EVENT_NAME="Anniv de Dan" \
BASE_URL=https://mur.exemple.com PURGE_DAYS=30 node server.js
```

Variables : `PORT` (3100), `EVENT_NAME`, `ADMIN_KEY` (obligatoire en prod), `EVENT_CODE`
(code de soirée, 16 caractères minimum, obligatoire en prod), `BASE_URL` (pour le QR),
`DATA_DIR` (./data), `PURGE_DAYS` (30, 0 = jamais).

Si `BASE_URL` est en https et que `EVENT_CODE` ou `ADMIN_KEY` manque, le service refuse de
démarrer (`ALLOW_OPEN=1` pour un mur public volontaire).

Les données (photos + `posts.json`) sont dans `DATA_DIR`, hors Git. À sauvegarder.

## Mise en ligne (pour Gad)

- Node ≥ 18, utilisateur système dédié, dossier dédié (ex. `/opt/le-mur`), service systemd à part.
- Reverse proxy : un vhost HTTPS dédié. Pour le temps réel (SSE sur `/api/stream`) :
  `proxy_buffering off;` `proxy_read_timeout 3600s;` et `client_max_body_size 8m;`.
- Le serveur envoie déjà `X-Accel-Buffering: no`.

Exemple d'unité systemd :

```ini
[Unit]
Description=Le Mur
After=network.target
[Service]
User=lemur
WorkingDirectory=/opt/le-mur
Environment=PORT=3100 EVENT_NAME=Anniv\x20de\x20Dan BASE_URL=https://mur.exemple.com
EnvironmentFile=/etc/le-mur.env
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
(`/etc/le-mur.env` contient `ADMIN_KEY=...`, droits 600.)

## Code de soirée

`EVENT_CODE` est caché dans le QR code (`/?c=<code>`). Au scan, le serveur pose un cookie
`HttpOnly` (7 jours) et retire le code de l'adresse. Sans ce cookie : les pages, l'API, le temps
réel et les photos répondent 403/401 ("Soirée privée"). L'admin (`ADMIN_KEY`) accède à tout, et
récupère le QR et le lien d'invitation depuis `/admin`. Le code n'apparaît dans aucune page publique.

## Données personnelles

- Pas de compte ; prénom/pseudo libre ; consentement affiché avant la première publication.
- Les photos sont ré-encodées côté navigateur (métadonnées EXIF / GPS supprimées).
- Chaque invité supprime ses propres posts ; l'hôte modère depuis `/admin`.
- Suppression automatique après `PURGE_DAYS` jours ; export zip puis purge totale depuis `/admin`.
- Aucun cookie tiers, aucun script ni police externe, aucun traceur.

## Limites connues (v0.1)

Pas de modération automatique des images, pas de multi-événements (un événement par instance),
stockage fichier (prévu pour quelques centaines de posts, plafond 3000).
