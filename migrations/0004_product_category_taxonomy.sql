UPDATE classification_items
SET display_name = '水联网', status = 'enabled', sort_order = 40
WHERE classification_type = 'category' AND item_code = 'water_heater'
-- statement-breakpoint
INSERT INTO classification_items (classification_type, item_code, display_name, description, status, sort_order)
VALUES
  ('category', 'refrigerator', '冰箱', NULL, 'enabled', 10),
  ('category', 'washing_machine', '洗衣机', NULL, 'enabled', 20),
  ('category', 'air_conditioner', '空调', NULL, 'enabled', 30),
  ('category', 'water_heater', '水联网', NULL, 'enabled', 40),
  ('category', 'kitchen_appliance', '厨电', NULL, 'enabled', 50),
  ('category', 'television', '彩电', NULL, 'enabled', 60),
  ('category', 'other', '其他', NULL, 'enabled', 70)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  status = VALUES(status),
  sort_order = VALUES(sort_order)
