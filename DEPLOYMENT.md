# Déploiement

Le multijoueur utilise Socket.IO dans `server.js`. GitHub Pages seul ne peut donc pas héberger les parties temps réel.

## Render

1. Pousser ce repo sur GitHub.
2. Ouvrir Render, puis créer un `Blueprint`.
3. Sélectionner le repo `bingo-social`.
4. Render lit `render.yaml`, installe les dépendances et lance `npm start`.
5. Utiliser l'URL Render comme adresse du jeu à partager aux joueurs.

Il faut jouer depuis l'URL Render, pas depuis GitHub Pages, sauf si un backend Socket.IO externe est configuré plus tard.
