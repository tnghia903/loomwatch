-- Apple Health readings a paired iPhone sent (ADR 0121), for the agents given the Apple Health
-- tool. Only the kinds the person switched on in LoomWatch on the iPhone arrive. `device` is the
-- phone's id in devices.json; removing the phone, or the tool, deletes its rows.
--
-- health_days: one figure a day for each kind (steps summed, heart rate averaged, the day's last
-- weight), replaced when the phone sends that day again.
CREATE TABLE health_days (
    device      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    day         TEXT NOT NULL,
    value       REAL NOT NULL,
    unit        TEXT NOT NULL,
    source      TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (device, kind, day)
);
CREATE INDEX health_days_kind_day ON health_days (kind, day);

-- health_events: what has a start and an end, a night's sleep or a workout, replaced when the
-- phone sends the same start again. `day` is the day it started where the person was: the date in
-- the offset the phone sent, or this computer's own time zone for a time sent in UTC.
CREATE TABLE health_events (
    device      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    start       TEXT NOT NULL,
    end         TEXT NOT NULL,
    day         TEXT NOT NULL,
    value       REAL,
    unit        TEXT,
    detail      TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (device, kind, start)
);
CREATE INDEX health_events_kind_day ON health_events (kind, day);
