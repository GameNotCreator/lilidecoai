import { ProductEditForm } from "@/components/product-edit-form";

export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductEditForm productId={id} />;
}
