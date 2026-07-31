# Widget marchand

Le script est servi par Next.js et ne contient aucun secret.

```html
<script
  src="https://visualizer.example/widget.js"
  data-merchant="atelier-lili"
  data-product="UUID_DU_PRODUIT"
  data-label="Voir chez moi"
  data-color="#667052"
  async
></script>
```

Le script crée un bouton accessible puis ouvre
`/visualizer/{merchantSlug}/{productId}` dans une modal responsive. Les
messages `postMessage` ne sont acceptés que depuis l’origine du script. La
configuration publique est lue via
`GET /v1/visualizer/{merchantSlug}/{productId}`.

Pour WooCommerce, injecter le fragment via un hook de fiche produit et utiliser
l’ID produit mappé dans la métadonnée du catalogue. Pour Shopify, un app block
Liquid pourra produire les mêmes attributs. Ces adaptateurs ne doivent jamais
embarquer les clés OpenAI, MongoDB ou Cloudinary.

En production, remplir `allowedOrigins` pour chaque widget et appliquer la même
liste dans la CSP/`frame-ancestors` du déploiement.
