import { notFound } from "next/navigation";
import { FountDetail } from "@/components/FountDetail";
import { catalog } from "@/generated/catalog";

export function generateStaticParams() {
  return Object.keys(catalog.equityTokens).map((ticker) => ({ ticker }));
}

export default function FountPage({ params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  if (!(ticker in catalog.equityTokens)) notFound();
  return <FountDetail ticker={ticker} />;
}
