# Déploiement

Le multijoueur utilise Socket.IO dans `server.js`. GitHub Pages seul ne peut donc pas héberger les parties temps réel.

## Render

1. Pousser ce repo sur GitHub.
2. Ouvrir Render, puis créer un `Blueprint`.
3. Sélectionner le repo `bingo-social`.
4. Render lit `render.yaml`, installe les dépendances et lance `npm start`.
5. Renseigner `ADMIN_PASSWORD` dans les variables d'environnement Render.
6. Utiliser l'URL Render comme adresse du jeu à partager aux joueurs.

Il faut jouer depuis l'URL Render, pas depuis GitHub Pages, sauf si un backend Socket.IO externe est configuré plus tard.

## Admin

L'édition des catégories se fait sur `/admin`.

En local, si `ADMIN_PASSWORD` n'est pas défini, le mot de passe par défaut est `binglou-admin`.
En production, `ADMIN_PASSWORD` est obligatoire.

Les catégories sont sauvegardées dans `CATEGORIES_FILE`, ou dans `categories.json` par défaut.

Attention: sur un service Render gratuit, le système de fichiers est éphémère. Les changements faits dans `/admin` sont appliqués en direct, mais peuvent être perdus après redéploiement, restart ou mise en veille. Pour les conserver durablement, il faut passer le service sur une offre payante avec disque persistant et définir `CATEGORIES_FILE=/var/data/categories.json`, ou brancher une base de données.
