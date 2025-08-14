export interface ProxyTarget {
  host: string;
  port: number;
  protocol: string;
}

export interface RequestLog {
  timestamp: string;
  method: string;
  url: string;
  host: string;
  ip: string;
  userAgent: string;
  targetUrl: string;
}

export interface WebSocketMessage {
  type: string;
  payload: any;
  timestamp: string;
  clientId: string;
}

export interface ProxyConfig {
  nextjsTarget: string;
  nestjsTarget: string;
  port: number;
  enableWebSockets: boolean;
  enableCors: boolean;
}

