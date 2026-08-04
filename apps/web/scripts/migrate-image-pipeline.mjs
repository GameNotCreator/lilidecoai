import { MongoClient } from "mongodb";

const apply = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB ?? "lilidecoai";

if (!uri) {
  console.error("MONGODB_URI est requise pour inspecter la migration.");
  process.exit(1);
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(databaseName);
  const products = database.collection("products");
  const renders = database.collection("renders");

  const legacyProducts = await products
    .find({ assetId: { $type: "string" }, views: { $exists: false } })
    .project({ id: 1, assetId: 1, createdAt: 1 })
    .toArray();
  const legacyRenders = await renders
    .find({
      $or: [
        { pipelineState: { $exists: false } },
        { mode: { $exists: false } },
        { promptVersion: { $exists: false } },
      ],
    })
    .project({
      id: 1,
      status: 1,
      placement: 1,
      provider: 1,
      model: 1,
      resultAssetId: 1,
      mode: 1,
      outputQuality: 1,
      pipelineState: 1,
      surfaceType: 1,
      promptVersion: 1,
      attemptCount: 1,
      qualityChecks: 1,
      estimatedCostUsd: 1,
      selectedResultAssetId: 1,
      modelChain: 1,
      createdAt: 1,
    })
    .toArray();

  console.log(
    `${apply ? "Application" : "Simulation"}: ${legacyProducts.length} produit(s), ${legacyRenders.length} rendu(s).`,
  );

  if (apply) {
    for (const product of legacyProducts) {
      await products.updateOne(
        { _id: product._id, views: { $exists: false } },
        {
          $set: {
            views: [
              {
                id: `legacy-front-${product.id}`,
                assetId: product.assetId,
                type: "front",
                widthPx: 0,
                heightPx: 0,
                validationStatus: "valid",
                createdAt: product.createdAt ?? new Date(),
              },
            ],
          },
        },
      );
    }

    for (const render of legacyRenders) {
      const pipelineState =
        render.status === "succeeded"
          ? "completed"
          : render.status === "failed"
            ? "failed"
            : render.status === "cancelled"
              ? "refunded"
              : "uploaded";
      const set = {
        mode:
          render.placement?.operation === "replace_existing"
            ? "replace"
            : "insert",
        outputQuality: "final",
        pipelineState,
        surfaceType: render.placement?.surfaceType ?? "tabletop",
        promptVersion: "legacy-v1",
        attemptCount: 0,
        qualityChecks: [],
        estimatedCostUsd: 0,
        modelChain:
          render.provider && render.model
            ? [
                {
                  provider: render.provider,
                  model: render.model,
                  role: "legacy_render",
                },
              ]
            : [],
      };
      if (render.resultAssetId) {
        set.selectedResultAssetId = render.resultAssetId;
      }
      for (const key of Object.keys(set)) {
        if (render[key] !== undefined) delete set[key];
      }
      if (Object.keys(set).length > 0) {
        await renders.updateOne({ _id: render._id }, { $set: set });
      }
    }
    console.log("Migration terminée sans suppression de données.");
  } else {
    console.log(
      "Aucune donnée modifiée. Relancez avec --apply pour appliquer.",
    );
  }
} finally {
  await client.close();
}
