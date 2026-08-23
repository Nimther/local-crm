# Requirements: Mega CRM — v1.2 Data Lifecycle & Delivery Trust

**Defined:** 2026-08-20
**Core Value:** Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced).

## v1.2 Requirements

Requirements for this milestone. Each maps to roadmap phases (continuing from Phase 18).

### Campaign Template Correctness

- [x] **TMPL-01**: Маркетолог не может запустить, запланировать или отправить test-send кампании с несохранённым выбором шаблона — dirty state явно виден и блокирует действие до сохранения
- [x] **TMPL-02**: Launch и schedule выполняются только относительно подтверждённо сохранённой версии кампании; конкурентное или несохранённое изменение приводит к типизированному conflict без запуска отправки
- [x] **TMPL-03**: Test-send отправляет ровно тот шаблон, что подтверждённо сохранён в кампании, — доказано тестом на все три send-пути (launch/schedule/test-send)

### DSR Contact Data Export

- [x] **DSR-01**: Owner/Admin может из карточки контакта скачать machine-readable файл с персональными данными контакта: профиль, custom properties, consent history
- [x] **DSR-02**: Выгрузка включает события контакта и связанные с отправками персональные данные (send-факты, статусы доставки), ограниченные данными этого субъекта
- [x] **DSR-03**: Все данные выгрузки ограничены workspace_id + contact_id; правила включения и редактирования freeform JSONB (events.properties, send_events.payload) определяются отдельным решением после анализа возможных данных других субъектов
- [ ] **DSR-04**: Member без Owner/Admin-роли не может запустить выгрузку (ролевой гейт на API и в UI)

### Workspace Purge

- [ ] **PRG-01**: Soft-deleted workspace физически purge'ится после policy-defined retention (платформенный default, задаёт оператор через env)
- [ ] **PRG-02**: Purge удаляет или обезличивает tenant PII во всех tenant-таблицах и удаляет tenant secrets (SendGrid key ciphertext, DEK, webhook endpoints), сохраняя compliance evidence, обязанное пережить тенанта
- [ ] **PRG-03**: Purge идемпотентен и возобновляем: checkpointed прогресс вне tenant-таблиц, повторный запуск и падение mid-purge безопасны
- [ ] **PRG-04**: Purge не затрагивает данные других workspace — batched DELETE внутри общих партиций (никаких DROP/DETACH/TRUNCATE), доказано негативными тестами
- [ ] **PRG-05**: Eligibility (soft-deleted + retention истёк) перепроверяется внутри каждого purge-батча — восстановленный workspace не purge'ится
- [ ] **PRG-06**: Soft-deleted workspace прекращает активность (quiesce): scheduled/sending кампании и flow-диспатчи не отправляют письма после soft-delete

### Unsubscribe Secret Rotation

- [x] **ROT-01**: Оператор может ввести новый primary unsubscribe-secret — новые письма подписываются им, без инвалидации ранее разосланных ссылок
- [x] **ROT-02**: Previous secrets продолжают проверять старые ссылки на обоих путях (GET и RFC 8058 POST) с timing-safe сравнением и byte-identical ответами (no-token-oracle инвариант сохранён)

### Dependency Hygiene

- [x] **DEP-01**: Все применимые HIGH advisories в достижимых production paths исправлены; остальные имеют документированный reachability-анализ и ограниченное по сроку исключение
- [x] **DEP-02**: CI блокирует появление новых неразобранных HIGH advisories (PR-diff + scheduled full-scan)
- [x] **DEP-03**: Доказанно недостижимые tooling-only findings принимаются через явный accept-list с justification и expiry (без формального zero-HIGH требования)

## Future Requirements

Deferred — tracked but not in current roadmap.

### Scale

- **SCALE-02**: PgBouncer при реальном давлении `max_connections` (deferred Phase 14 D-09)
- **SCALE-03**: Бенчмарк сегментации на 100k–1M контактов

### Operational

- **OPS-LIVE-01**: Live operator-alert email walkthrough (Phase 9 debt)
- **OPS-LIVE-02**: Оставшиеся live compliance-walkthrough'ы Phase 13
- **OPS-LIVE-03**: KEK quick-task 260818-aqd Task 3 (production провижининг file-backed KEK, operator-only)
- **OPS-UI-01**: UI follow-ups Phase 15 (LaunchConfirmDialog, CsvImportWizard) + tuning порогов алертов

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Перепланирование реализованных подсистем (RLS, CI, backups, contact erasure, event retention, KMS, очереди, observability) | Явное указание оператора — новые требования интегрируются в существующие механизмы |
| Async-генерация DSR-выгрузки (background job + notification) | Синхронная streamed-выгрузка достаточна при текущих объёмах — leading (workspace_id, contact_id) индексы на всех таблицах; усложнять до измеренной необходимости нельзя |
| Per-workspace настройка purge retention | Платформенный default проще и предсказуемее; per-workspace — если появится спрос |
| Полный DSR-workflow (intake-формы, статусы запросов, дедлайн-трекинг) | v1.2 даёт механизм выгрузки; процессный workflow — вне scope |
| Автоматическая ротация unsubscribe-secret по расписанию | v1.2 даёт graceful-механизм; автоматизация ротации — операционное решение позже |
| Zero-HIGH policy по всем advisories | Явное указание оператора: недостижимые tooling-only findings принимаются через accept-list |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TMPL-01 | Phase 20 | Complete |
| TMPL-02 | Phase 20 | Complete |
| TMPL-03 | Phase 20 | Complete |
| DSR-01 | Phase 21 | Complete |
| DSR-02 | Phase 21 | Complete |
| DSR-03 | Phase 21 | Complete |
| DSR-04 | Phase 21 | Pending |
| PRG-01 | Phase 22 | Pending |
| PRG-02 | Phase 22 | Pending |
| PRG-03 | Phase 22 | Pending |
| PRG-04 | Phase 22 | Pending |
| PRG-05 | Phase 22 | Pending |
| PRG-06 | Phase 22 | Pending |
| ROT-01 | Phase 19 | Complete |
| ROT-02 | Phase 19 | Complete |
| DEP-01 | Phase 18 | Complete |
| DEP-02 | Phase 18 | Complete |
| DEP-03 | Phase 18 | Complete |

**Coverage:**

- v1.2 requirements: 18 total
- Mapped to phases: 18 ✓ (Phase 18: 3, Phase 19: 2, Phase 20: 3, Phase 21: 4, Phase 22: 6)
- Unmapped: 0 ✓
- No requirement is mapped to more than one phase.

---
*Requirements defined: 2026-08-20*
*Last updated: 2026-08-20 after roadmap creation (Phases 18-22)*
