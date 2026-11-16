import * as Primitive from "@radix-ui/react-select";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type KeyboardEvent,
} from "react";
import { styleNonce } from "../lib/csp-nonce.js";
import { Icon } from "./Icon.js";
import { Button } from "./Button.js";

type Option = ReactElement<{ value?: string; children?: ReactNode; disabled?: boolean }>;
function optionsIn(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return child.type === Fragment ? optionsIn(child.props.children) : child.type === "option" ? [child as Option] : [];
  });
}

// Prefix every value so an empty (clear/None) option remains selectable in Radix.
const encode = (value: string) => `option:${value}`;

export function Select({
  children,
  value,
  onChange,
  disabled,
  className,
  searchable,
  searchPlaceholder = "Search…",
  ...props
}: {
  children: ReactNode;
  value: string;
  disabled?: boolean;
  onChange: (event: { target: { value: string } }) => void;
  "aria-label"?: string;
  "aria-describedby"?: string;
  id?: string;
  className?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const options = optionsIn(children);
  const isSearchable = searchable ?? options.length > 7;
  const listId = useId();
  /** What the list is, for the search field's and the list's names: the trigger's own name, or what the search finds. */
  const listName = props["aria-label"] ?? searchPlaceholder.replace(/…$/, "");

  useEffect(() => {
    if (!open) {
      setSearch("");
      return undefined;
    }
    // When opened, ensure the currently selected item is visible, centered, and focused
    const scrollToSelected = () => {
      const content = contentRef.current;
      if (!content) return;
      const selectedItem =
        content.querySelector<HTMLElement>('[role="option"][data-state="checked"], [role="option"][aria-selected="true"]') ??
        content.querySelector<HTMLElement>('[role="option"]:not([data-disabled="true"]):not([aria-disabled="true"])');
      if (!selectedItem) return;

      // If focus has already moved to something else inside the content (e.g. user typed into search), don't steal it
      if (document.activeElement && document.activeElement !== selectedItem && content.contains(document.activeElement)) {
        return;
      }

      const viewport = content.querySelector<HTMLElement>("[data-radix-select-viewport]");
      if (viewport && viewport.clientHeight > 0) {
        viewport.scrollTop = Math.max(0, selectedItem.offsetTop - (viewport.clientHeight - selectedItem.offsetHeight) / 2);
      } else {
        selectedItem.scrollIntoView({ block: "center", inline: "nearest" });
      }
      selectedItem.focus({ preventScroll: true });
    };

    let again: ReturnType<typeof setTimeout> | undefined;
    const id = requestAnimationFrame(() => {
      scrollToSelected();
      again = setTimeout(scrollToSelected, 20);
    });
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(again);
    };
  }, [open]);

  const query = search.trim().toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  const filteredOptions = query
    ? options.filter((option) => {
        const text = `${String(option.props.children ?? "")} ${option.props.value ?? ""}`.toLowerCase();
        return tokens.every((tok) => text.includes(tok));
      })
    : options;

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      const firstItem = contentRef.current?.querySelector<HTMLElement>(
        '[role="option"]:not([data-disabled="true"]):not([aria-disabled="true"])',
      );
      firstItem?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const firstMatch = filteredOptions.find((opt) => !opt.props.disabled);
      if (firstMatch) {
        const itemValue = firstMatch.props.value ?? String(firstMatch.props.children ?? "");
        onChange({ target: { value: itemValue } });
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape") {
      if (search) {
        event.preventDefault();
        event.stopPropagation();
        setSearch("");
        const selectedItem = contentRef.current?.querySelector<HTMLElement>(
          '[role="option"][data-state="checked"], [role="option"][aria-selected="true"]',
        );
        if (selectedItem) {
          const viewport = contentRef.current?.querySelector<HTMLElement>("[data-radix-select-viewport]");
          if (viewport && viewport.clientHeight > 0) {
            viewport.scrollTop = Math.max(0, selectedItem.offsetTop - (viewport.clientHeight - selectedItem.offsetHeight) / 2);
          } else {
            selectedItem.scrollIntoView({ block: "center", inline: "nearest" });
          }
          selectedItem.focus({ preventScroll: true });
        }
        return;
      }
      return;
    }
    event.stopPropagation();
  };

  const handleContentKeyDown = (event: KeyboardEvent) => {
    // If user types a printable character while browsing options, route directly to search!
    if (
      isSearchable &&
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      document.activeElement !== searchInputRef.current
    ) {
      event.preventDefault();
      event.stopPropagation();
      setSearch((prev) => prev + event.key);
      searchInputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowUp" && isSearchable) {
      const items = contentRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([data-disabled="true"])');
      if (items && items.length > 0 && document.activeElement === items[0]) {
        event.preventDefault();
        searchInputRef.current?.focus({ preventScroll: true });
      }
    }
  };

  return (
    <Primitive.Root
      open={open}
      onOpenChange={setOpen}
      value={encode(value)}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        setOpen(false);
        onChange({ target: { value: next.slice(7) } });
      }}
    >
      <Primitive.Trigger
        {...props}
        data-value={value}
        className={className === undefined ? "select-trigger" : `select-trigger ${className}`}
      >
        <Primitive.Value />
        <Primitive.Icon aria-hidden="true">
          <Icon name="chevron-down" size="sm" />
        </Primitive.Icon>
      </Primitive.Trigger>
      {/* Keep content in the dialog's top layer when used inside a modal. */}
      <Primitive.Content
        ref={contentRef}
        position="popper"
        sideOffset={6}
        className="select-content surface-popover"
        onKeyDown={handleContentKeyDown}
        // Searchable, it holds a search field and a list: the list alone is the listbox.
        {...(isSearchable ? { role: "dialog", "aria-label": listName } : {})}
      >
        {isSearchable ? (
          <div className="select-search" onPointerDown={(e) => e.stopPropagation()}>
            <div className="select-search-box">
              <Icon name="search" size="sm" />
              <input
                ref={searchInputRef}
                type="text"
                className="select-search-input"
                aria-label={searchPlaceholder.replace(/…$/, "")}
                aria-controls={listId}
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => {
                  if (document.activeElement !== searchInputRef.current) {
                    searchInputRef.current?.focus({ preventScroll: true });
                  }
                  setSearch(e.target.value);
                }}
                onKeyDown={handleSearchKeyDown}
              />
              {search ? (
                <Button
                  className="select-search-clear"
                  aria-label="Clear search"
                  tabIndex={-1}
                  onClick={() => {
                    setSearch("");
                    searchInputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <Icon name="close" size="sm" />
                </Button>
              ) : null}
            </div>
            {/* In the page from the moment the list opens, so each count is heard as the search narrows it. */}
            <p className="visually-hidden" role="status">
              {query === ""
                ? ""
                : filteredOptions.length === 0
                  ? "No results found"
                  : `${filteredOptions.length} ${filteredOptions.length === 1 ? "result" : "results"}`}
            </p>
          </div>
        ) : null}
        {filteredOptions.length === 0 ? (
          <div className="select-empty" aria-hidden={isSearchable ? true : undefined}>
            No results found
          </div>
        ) : null}
        <Primitive.ScrollUpButton className="select-scroll">
          <Icon name="chevron-up" size="sm" />
        </Primitive.ScrollUpButton>
        {/* The viewport draws its own <style>: it carries the page's nonce, which the canvas's policy asks of every inline style. */}
        <Primitive.Viewport
          className="select-options"
          nonce={styleNonce()}
          {...(isSearchable ? { id: listId, role: "listbox", "aria-label": listName } : {})}
        >
          {filteredOptions.map((option) => {
            const itemValue = option.props.value ?? String(option.props.children ?? "");
            return (
              <Primitive.Item
                key={itemValue}
                value={encode(itemValue)}
                data-value={itemValue}
                disabled={option.props.disabled ?? false}
                className="select-option"
              >
                <Primitive.ItemIndicator className="select-check" aria-hidden="true">
                  <Icon name="check" size="sm" />
                </Primitive.ItemIndicator>
                <Primitive.ItemText>{option.props.children}</Primitive.ItemText>
              </Primitive.Item>
            );
          })}
        </Primitive.Viewport>
        <Primitive.ScrollDownButton className="select-scroll">
          <Icon name="chevron-down" size="sm" />
        </Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Root>
  );
}
