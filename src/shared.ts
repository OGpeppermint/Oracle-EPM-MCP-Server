export type ConnectionStatus = {
  configured: boolean;
  baseUrl?: string;
  application?: string;
  username?: string;
  missing: string[];
};

export type DashboardData = {
  connection: ConnectionStatus;
  checkedAt: string;
};
