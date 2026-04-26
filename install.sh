#!/bin/bash
set -e

REPO_DIR="$(git rev-parse --show-toplevel)"
TARGET_DIR="$HOME/.pi/agent/extensions"

# Write extensions to a file so we can index by line number
EXT_FILE=$(mktemp)
find "$REPO_DIR" \( -path "*/extensions/*.ts" -o -path "*/extensions/*/index.ts" \) -type f | sort > "$EXT_FILE"
count=$(wc -l < "$EXT_FILE" | tr -d ' ')
trap "rm -f $EXT_FILE" EXIT

if [ "$count" -eq 0 ]; then
    echo "No extensions found"
    exit 0
fi

# Colors for authors
COLORS=("\033[31m" "\033[32m" "\033[33m" "\033[34m" "\033[35m" "\033[36m")
RESET="\033[0m"

# Assign a color to each unique author
author_color() {
    author="$1"
    # Hash the author name to pick a consistent color
    idx=$(echo "$author" | cksum | awk '{print $1 % 6}')
    echo "${COLORS[$idx]}"
}

render() {
    clear
    echo "=== Extensions ==="
    echo ""
    i=1
    while IFS= read -r ext; do
        if [ "$(basename "$ext")" = "index.ts" ]; then
            filename=$(basename "$(dirname "$ext")")
        else
            filename=$(basename "$ext" .ts)
        fi
        author=$(echo "$ext" | sed "s|$REPO_DIR/||" | cut -d'/' -f1)
        color=$(author_color "$author")

        if [ "$(basename "$ext")" = "index.ts" ]; then
            target="$TARGET_DIR/$filename"
        else
            target="$TARGET_DIR/$(basename "$ext")"
        fi

        if [ -L "$target" ]; then
            printf "  [x] %s) ${color}%s${RESET} • %s\n" "$i" "$author" "$filename"
        else
            printf "  [ ] %s) ${color}%s${RESET} • %s\n" "$i" "$author" "$filename"
        fi
        i=$((i + 1))
    done < "$EXT_FILE"
    echo ""
    printf "1-$count: toggle | Enter: save & quit\n"
}

toggle() {
    ext=$(sed -n "${1}p" "$EXT_FILE")
    if [ "$(basename "$ext")" = "index.ts" ]; then
        source=$(dirname "$ext")
        target="$TARGET_DIR/$(basename "$source")"
    else
        source="$ext"
        target="$TARGET_DIR/$(basename "$ext")"
    fi

    if [ -L "$target" ]; then
        rm "$target"
    else
        mkdir -p "$TARGET_DIR"
        ln -s "$source" "$target"
    fi
}

while true; do
    render
    read -rn1 key
    case $key in
        ''|q|Q) echo ""; exit 0 ;;
        [1-9])
            if [ "$key" -le "$count" ]; then
                toggle "$key"
            fi
            ;;
    esac
done
