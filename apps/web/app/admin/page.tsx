import { AdminPage } from "@/components/app-data-pages";
import { requireMerchantPage } from "@/lib/server/page-auth";

export default async function Page() {
  await requireMerchantPage("/admin");
  return <AdminPage />;
}
