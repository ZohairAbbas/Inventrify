import { Badge } from "@shopify/polaris";

type StockStatus = "healthy" | "low" | "critical" | "stockout";

interface Props {
  status: StockStatus;
}

const config: Record<StockStatus, { tone: "success" | "warning" | "critical" | "new"; label: string }> = {
  healthy: { tone: "success", label: "Healthy" },
  low: { tone: "warning", label: "Low" },
  critical: { tone: "critical", label: "Critical" },
  stockout: { tone: "new", label: "Stockout" },
};

export function StockStatusBadge({ status }: Props) {
  const { tone, label } = config[status];
  return <Badge tone={tone}>{label}</Badge>;
}
