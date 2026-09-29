import type { Metadata } from "next";
import { StorefrontBasket } from "@/components/storefront/storefront-basket";
export const metadata: Metadata = {
  title: "Votre panier",
  robots: { index: false, follow: false },
};
export default function BasketPage() {
  return <StorefrontBasket />;
}
