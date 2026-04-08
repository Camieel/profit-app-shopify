// app/components/DateRangePicker.tsx
// Shared date range picker used across Dashboard, Orders, Products, Ads.
//
// Features:
// - Preset buttons (Today / Yesterday / 7d / 30d / This month / Last month / 90d)
// - Custom range via Polaris DatePicker in a Popover
// - Syncs selected range to localStorage ("cp_date_range") so all pages stay in sync
// - Reads from localStorage on mount if no URL params are set
// - Calls onUpdate(from, to) when range changes — parent updates URL params

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Card, InlineStack, Button, Text, Popover, DatePicker, BlockStack, Box,
} from "@shopify/polaris";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

interface Props {
  dateFrom: string;
  dateTo: string;
  onUpdate: (from: string, to: string) => void;
  /** Pages that don't use expenses can pass false to hide This Month preset label tweak */
  showLabel?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (d: Date) => d.toISOString().split("T")[0];

function todayStr() { return fmt(new Date()); }

function buildPresets() {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  return [
    { label: "Today",      from: fmt(today), to: fmt(today) },
    { label: "Yesterday",  from: fmt(new Date(today.getTime() - 86400000)), to: fmt(new Date(today.getTime() - 86400000)) },
    { label: "7 days",     from: fmt(new Date(today.getTime() - 7  * 86400000)), to: fmt(today) },
    { label: "30 days",    from: fmt(new Date(today.getTime() - 30 * 86400000)), to: fmt(today) },
    { label: "This month", from: fmt(new Date(y, m, 1)), to: fmt(today) },
    { label: "Last month", from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) },
    { label: "90 days",    from: fmt(new Date(today.getTime() - 90 * 86400000)), to: fmt(today) },
  ];
}

const STORAGE_KEY = "cp_date_range";

function saveToStorage(from: string, to: string) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ from, to })); } catch {}
}

export function loadFromStorage(): DateRange | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DateRange;
    if (parsed.from && parsed.to) return parsed;
    return null;
  } catch { return null; }
}

// Convert YYYY-MM-DD string to {year, month, day} for Polaris DatePicker
function strToDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ── Component ─────────────────────────────────────────────────────────────────
export function DateRangePicker({ dateFrom, dateTo, onUpdate, showLabel = true }: Props) {
  const presets = buildPresets();
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Calendar state — tracks what month is shown
  const initDate = strToDate(dateFrom);
  const [{ month, year }, setMonthYear] = useState({
    month: initDate.getMonth(),
    year: initDate.getFullYear(),
  });

  // Selected range in Polaris format
  const [selectedDates, setSelectedDates] = useState<{
    start: Date;
    end: Date;
  }>({ start: strToDate(dateFrom), end: strToDate(dateTo) });

  // Pending range while the calendar is open (don't apply until Apply clicked)
  const [pendingFrom, setPendingFrom] = useState(dateFrom);
  const [pendingTo, setPendingTo] = useState(dateTo);

  const activePreset = presets.find((p) => p.from === dateFrom && p.to === dateTo);

  const handlePreset = useCallback((p: { from: string; to: string }) => {
    saveToStorage(p.from, p.to);
    onUpdate(p.from, p.to);
  }, [onUpdate]);

  const handleCalendarChange = useCallback((range: { start: Date; end: Date }) => {
    setSelectedDates(range);
    setPendingFrom(fmt(range.start));
    setPendingTo(fmt(range.end));
  }, []);

  const handleApply = useCallback(() => {
    saveToStorage(pendingFrom, pendingTo);
    onUpdate(pendingFrom, pendingTo);
    setPopoverOpen(false);
  }, [pendingFrom, pendingTo, onUpdate]);

  const handleMonthChange = useCallback((month: number, year: number) => {
    setMonthYear({ month, year });
  }, []);

  // Reset calendar state when popover opens
  const handleTogglePopover = useCallback(() => {
    if (!popoverOpen) {
      const d = strToDate(dateFrom);
      setMonthYear({ month: d.getMonth(), year: d.getFullYear() });
      setSelectedDates({ start: strToDate(dateFrom), end: strToDate(dateTo) });
      setPendingFrom(dateFrom);
      setPendingTo(dateTo);
    }
    setPopoverOpen((v) => !v);
  }, [popoverOpen, dateFrom, dateTo]);

  const customLabel = activePreset ? null : `${dateFrom} → ${dateTo}`;

  return (
    <Card>
      <InlineStack gap="200" wrap align="space-between" blockAlign="center">
        {/* Presets */}
        <InlineStack gap="150" wrap>
          {presets.map((p) => {
            const active = dateFrom === p.from && dateTo === p.to;
            return (
              <Button
                key={p.label}
                size="slim"
                variant={active ? "primary" : "plain"}
                onClick={() => handlePreset(p)}
              >
                {p.label}
              </Button>
            );
          })}

          {/* Custom range via Popover */}
          <Popover
            active={popoverOpen}
            activator={
              <Button
                size="slim"
                variant={!activePreset ? "primary" : "plain"}
                onClick={handleTogglePopover}
                disclosure
              >
                {customLabel ?? "Custom"}
              </Button>
            }
            onClose={() => setPopoverOpen(false)}
            preferredAlignment="left"
          >
            <Box padding="400">
              <BlockStack gap="400">
                <DatePicker
                  month={month}
                  year={year}
                  selected={selectedDates}
                  onMonthChange={handleMonthChange}
                  onChange={handleCalendarChange}
                  allowRange
                  disableDatesAfter={new Date()}
                />
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`${pendingFrom} → ${pendingTo}`}
                  </Text>
                  <InlineStack gap="200">
                    <Button size="slim" onClick={() => setPopoverOpen(false)}>Cancel</Button>
                    <Button
                      size="slim"
                      variant="primary"
                      onClick={handleApply}
                      disabled={pendingFrom === dateFrom && pendingTo === dateTo}
                    >
                      Apply
                    </Button>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </Box>
          </Popover>
        </InlineStack>

        {/* Active range label */}
        {showLabel && (
          <Text variant="bodySm" as="p" tone="subdued">
            {activePreset
              ? `${activePreset.label}: ${dateFrom} → ${dateTo}`
              : `${dateFrom} → ${dateTo}`}
          </Text>
        )}
      </InlineStack>
    </Card>
  );
}