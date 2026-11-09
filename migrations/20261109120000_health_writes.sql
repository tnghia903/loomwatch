-- What agents logged into Apple Health through a paired iPhone (ADR 0123). A Mac has no Health
-- store: each entry waits here until the phone takes it, saves it in Health and says how it went.
--
-- action: 'add' an entry, or 'remove' one this table added (`target` is its id).
-- kind: 'meal', 'water' or 'weight'. amounts: a JSON object such as {"energy_kcal": 920}.
-- state: 'waiting' for the phone, 'saved', 'refused' (with `said`), or 'removed' for an added
-- entry a later remove took out of Health.
-- `device` is the phone's id in devices.json; removing the phone, or the tool, deletes its rows.
CREATE TABLE health_writes (
    id         TEXT PRIMARY KEY,
    device     TEXT NOT NULL,
    action     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    at         TEXT NOT NULL,
    day        TEXT NOT NULL,
    name       TEXT,
    amounts    TEXT NOT NULL,
    target     TEXT,
    state      TEXT NOT NULL,
    said       TEXT,
    asked_at   TEXT NOT NULL,
    settled_at TEXT
);
CREATE INDEX health_writes_device_state ON health_writes (device, state);
CREATE INDEX health_writes_day ON health_writes (day);
