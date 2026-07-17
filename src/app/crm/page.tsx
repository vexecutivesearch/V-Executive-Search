import { redirect } from "next/navigation";

/**
 * Platform entry linked from the marketing landing page ("Try for free").
 * On deployments that ship the consolidated CRM UI, replace this redirect
 * with the real CRM page. Until then, send visitors to Today's List.
 */
export default function CrmEntryPage() {
  redirect("/today");
}
