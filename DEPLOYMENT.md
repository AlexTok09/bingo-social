# Déploiement

Le multijoueur utilise Socket.IO dans `server.js`. GitHub Pages seul ne peut donc pas héberger les parties temps réel.

## Render

1. Pousser ce repo sur GitHub.
2. Ouvrir Render, puis créer un `Blueprint`.
3. Sélectionner le repo `bingo-social`.
4. Render lit `render.yaml`, crée le service web et le Key Value Redis/Valkey interne, installe les dépendances et lance `npm start`.
5. Renseigner `ADMIN_PASSWORD` dans les variables d'environnement Render.
6. Configurer les DNS Porkbun pour `sociolobingo.com`, puis utiliser `https://sociolobingo.com` comme adresse du jeu.

Il faut jouer depuis l'URL Render, pas depuis GitHub Pages, sauf si un backend Socket.IO externe est configuré plus tard.

Le Blueprint configure :

- `bingo-social` en Web Service Node, plan `standard`, région `frankfurt`.
- `bingo-social-redis` en Render Key Value, accès interne uniquement.
- `REDIS_URL` injecté automatiquement dans le service web.
- `sociolobingo.com` et `www.sociolobingo.com` comme domaines custom.

## DNS Porkbun

Dans Porkbun, pointer le domaine vers Render :

- `sociolobingo.com` : record `A` vers l'adresse fournie par Render pour l'apex.
- `www.sociolobingo.com` : record `CNAME` vers le domaine Render du service, par exemple `bingo-social.onrender.com`.
- Supprimer les records `AAAA` si Render demande de le faire.

Render fournit le HTTPS automatiquement une fois les DNS validés.

## Redis/Valkey

Si `REDIS_URL`, `VALKEY_URL` ou `KEY_VALUE_URL` est défini, le serveur active :

- l'adapter Redis Socket.IO pour préparer le multi-instance ;
- la sauvegarde des salons pendant 4 heures ;
- la restauration des salons après redémarrage du process.

Sans variable Redis, le jeu fonctionne comme avant avec les salons uniquement en mémoire.

## Test de charge

Lancer le serveur local :

```sh
npm start
```

Dans un autre terminal, lancer un test court :

```sh
PLAYERS=100 ROOMS=5 DURATION_MS=60000 npm run load:test
```

Test 1000 joueurs :

```sh
npm run load:test:1k
```

Pour tester la prod :

```sh
URL=https://sociolobingo.com npm run load:test:1k
```

Les refus `La partie est déjà terminée.` sont des refus métier normaux si les bots cliquent assez vite pour terminer une grille. Les champs importants sont `live`, `connected`, `errors` et les disconnects inattendus avant la fin.

## Admin

L'édition des catégories se fait sur `/admin`.

En local, si `ADMIN_PASSWORD` n'est pas défini, le mot de passe par défaut est `binglou-admin`.
En production, `ADMIN_PASSWORD` est obligatoire.

Les catégories sont sauvegardées dans `CATEGORIES_FILE`, ou dans `categories.json` par défaut.

Attention: les salons sont maintenant persistés dans Redis/Valkey si `REDIS_URL` est actif, mais les catégories admin restent sauvegardées dans `CATEGORIES_FILE`. Pour conserver durablement les modifications faites dans `/admin`, utiliser un disque persistant Render avec `CATEGORIES_FILE=/var/data/categories.json`, ou déplacer les catégories dans une base de données.

Les grilles créées par les joueurs sont sauvegardées dans `CUSTOM_GRIDS_FILE`, ou `custom-grids.json` par défaut. En production Render, prévoir aussi un disque persistant avec `CUSTOM_GRIDS_FILE=/var/data/custom-grids.json`, ou déplacer ces grilles dans une base de données, sinon elles peuvent disparaître après redéploiement ou redémarrage.
