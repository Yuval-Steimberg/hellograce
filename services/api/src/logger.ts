import pino, { type Logger } from 'pino';

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    base: { service: 'grace-api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-twilio-signature"]',
        'twilio.AuthToken',
        '*.GEMINI_API_KEY',
        '*.password',
        '*.phone',
        '*.userId',
        '*.first_name',
        '*.medication',
        '*.current_weight',
        '*.goal_weight',
        '*.dose_mg',
      ],
      remove: true,
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
      : {}),
  });
}
