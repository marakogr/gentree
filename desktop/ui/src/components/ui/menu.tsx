import { useState } from "react";
import type { ReactNode } from "react";
import {
  Menu,
  MenuDivider,
  MenuItem as FluentMenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  menuItemClassNames,
  tokens,
} from "@fluentui/react-components";
import { MoreHorizontalRegular } from "@fluentui/react-icons";
import { Button } from "./button";

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Renders a separator instead of a row; `label` is ignored. */
  divider?: boolean;
  onSelect?: () => void;
};

export type MenuButtonProps = {
  label: string;
  items: MenuItem[];
  /**
   * Kept for API compatibility only. Fluent positions the popover itself and
   * shifts/flips it at viewport edges, so there is no explicit start/end
   * alignment to apply here.
   */
  align?: "start" | "end";
  /** Renders a "..." glyph; `label` stays the accessible name. */
  iconOnly?: boolean;
  /** Optional glyph after a text label, e.g. a chevron. */
  trailingIcon?: ReactNode;
  /** 28px square instead of 32px, for dense table rows. */
  dense?: boolean;
};

const useStyles = makeStyles({
  // Fluent MenuItem has no danger variant: the colour has to come from tokens.
  danger: {
    color: tokens.colorStatusDangerForeground1,
    ":hover": {
      color: tokens.colorStatusDangerForeground2,
    },
    ":hover:active": {
      color: tokens.colorStatusDangerForeground2,
    },
    // Without this the icon keeps Fluent's brand-coloured hover token.
    [`&:hover .${menuItemClassNames.icon}`]: {
      color: tokens.colorStatusDangerForeground2,
    },
  },
  // Square icon trigger: no border at rest, hover only.
  iconTrigger: {
    width: "32px",
    minWidth: "32px",
    height: "32px",
    padding: 0,
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground2,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
    ":hover:active": {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
      color: tokens.colorNeutralForeground1,
    },
  },
  open: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    color: tokens.colorNeutralForeground1,
  },
});

export function MenuButton({
  label,
  items,
  align = "start",
  iconOnly = false,
  trailingIcon,
  dense = false,
}: MenuButtonProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);

  return (
    <div className="menu-root">
      <Menu
        open={open}
        onOpenChange={(_event, data) => setOpen(data.open)}
        positioning={align === "end" ? "below-end" : "below-start"}
      >
        <MenuTrigger disableButtonEnhancement>
          <Button
            variant={iconOnly ? "ghost" : "secondary"}
            size="sm"
            className={
              iconOnly
                ? [styles.iconTrigger, open ? styles.open : null]
                    .filter(Boolean)
                    .join(" ")
                : undefined
            }
            style={
              iconOnly && dense
                ? { width: 28, minWidth: 28, height: 28 }
                : undefined
            }
            aria-label={iconOnly ? label : undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            title={iconOnly ? label : undefined}
          >
            {iconOnly ? (
              <MoreHorizontalRegular fontSize={16} aria-hidden="true" />
            ) : (
              <>
                {label}
                {trailingIcon ? (
                  <span aria-hidden="true">{trailingIcon}</span>
                ) : null}
              </>
            )}
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {items.map((item) =>
              item.divider ? (
                <MenuDivider key={item.id} />
              ) : (
                <FluentMenuItem
                  key={item.id}
                  icon={
                    item.icon ? (
                      <span aria-hidden="true">{item.icon}</span>
                    ) : undefined
                  }
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  className={item.danger ? styles.danger : undefined}
                  onClick={item.onSelect}
                >
                  {item.label}
                </FluentMenuItem>
              ),
            )}
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}
