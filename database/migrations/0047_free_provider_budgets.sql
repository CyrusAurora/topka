-- Circuit breakers for the free provider chain: OpenCode Zen, Agnes, and hy3 (used by an optional chat plugin).
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('opencode', 30, 900, 5000, 'OpenCode Zen 免费模型调用熔断'),
  ('agnes', 30, 900, 5000, 'Agnes 免费模型调用熔断'),
  ('hy3', 10, 200, 400, '插件对话（hy3）调用熔断')
ON CONFLICT (service) DO NOTHING;
