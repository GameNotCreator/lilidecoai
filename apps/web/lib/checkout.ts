import { z } from "zod";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      "Ce champ contient des caractères invalides.",
    );

export const orderRequestSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    fullName: text(100).refine(
      (value) => value.length >= 2,
      "Indiquez votre nom.",
    ),
    phone: text(30).refine(
      (value) =>
        /^\+?[\d ()-.]{8,30}$/.test(value) &&
        value.replace(/\D/g, "").length >= 8,
      "Indiquez un numéro de téléphone valide.",
    ),
    city: text(100).refine(
      (value) => value.length >= 2,
      "Indiquez votre ville.",
    ),
    email: z
      .union([z.literal(""), z.email().max(254)])
      .transform((value) => value.toLowerCase()),
    address: text(400).default(""),
    note: text(1000).default(""),
    consent: z.literal(true, {
      error: "Consultez et acceptez les conditions et la confidentialité.",
    }),
    website: z.literal("").default(""),
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(
        20,
        "Votre demande peut contenir jusqu’à 20 articles différents. Ajustez votre panier.",
      ),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.productId)).size ===
      value.items.length,
    {
      path: ["items"],
      message: "Un article figure plusieurs fois dans la sélection.",
    },
  );

export type OrderRequestInput = z.infer<typeof orderRequestSchema>;
export type OrderRequestStatus = "new" | "contacted" | "closed";
export type OrderReceipt = {
  reference: string;
  recorded: true;
  notification: "sent" | "pending";
};
export type CheckoutAvailability = { available: boolean; reason?: string };

export const orderStatusLabels: Record<OrderRequestStatus, string> = {
  new: "À traiter",
  contacted: "Client contacté",
  closed: "Clôturée",
};
