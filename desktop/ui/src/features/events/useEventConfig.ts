// Shared read of the event-related global config: custom type names and the
// `event_fields.custom` groups (ADR-0015). The form and the person card both
// need them, so they share one hook instead of invoking settings twice.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CustomEventFieldGroup } from "./fields";

/** Dispatched by the settings screen after a successful save. */
export const SETTINGS_SAVED_EVENT = "gentree:settings-saved";

/** Only the config sections this hook needs; the rest is ignored. */
type EventConfigResponse = {
  config?: {
    event_types?: { custom?: string[] };
    event_fields?: { custom?: CustomEventFieldGroup[] };
    geocoder?: { enabled?: boolean };
    historical_geocoder?: { enabled?: boolean };
  };
};

export type EventConfig = {
  customTypes: string[];
  fieldGroups: CustomEventFieldGroup[];
  /** Opt-in online address suggestions (ADR-0016); off by default. */
  geocoderEnabled: boolean;
  /** Historical names through Wikidata (ADR-0021); on by default. */
  historicalEnabled: boolean;
};

const EMPTY_CONFIG: EventConfig = {
  customTypes: [],
  fieldGroups: [],
  geocoderEnabled: false,
  historicalEnabled: false,
};

/**
 * Config for event types and detail fields, reloaded after a settings save.
 * A missing or failing settings backend leaves empty defaults: built-in types
 * and built-in detail keys stay usable without any config.
 */
export function useEventConfig(): EventConfig {
  const [config, setConfig] = useState<EventConfig>(EMPTY_CONFIG);

  useEffect(() => {
    let active = true;
    const load = () => {
      void invoke<EventConfigResponse>("settings_get")
        .then((snapshot) => {
          if (!active) return;
          setConfig({
            customTypes: snapshot.config?.event_types?.custom ?? [],
            fieldGroups: snapshot.config?.event_fields?.custom ?? [],
            geocoderEnabled: snapshot.config?.geocoder?.enabled === true,
            historicalEnabled:
              snapshot.config?.historical_geocoder?.enabled === true,
          });
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(SETTINGS_SAVED_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(SETTINGS_SAVED_EVENT, load);
    };
  }, []);

  return config;
}
