import { SettingsRegular } from "@fluentui/react-icons";
import { MenuButton, type MenuItem } from "../ui/menu";

export type ColumnMenuProps = {
  /** Accessible name of the gear trigger, already translated. */
  label: string;
  items: MenuItem[];
  align?: "start" | "end";
};

/** Gear menu that toggles column visibility. */
export function ColumnMenu({ label, items, align = "end" }: ColumnMenuProps) {
  return (
    <MenuButton
      iconOnly
      icon={<SettingsRegular fontSize={16} aria-hidden="true" />}
      label={label}
      items={items}
      align={align}
    />
  );
}
