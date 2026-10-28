# -*- mode: shell-script -*-
##
## Vendored from 0k-pkg (``ts/autogen.d/20-org-to-md.sh``).
## Refresh with ``pkg vendor``; to keep local edits, add a line
## ``## pkgcmd: local-override`` in the first five lines.
##
## Generates ``README.md`` from ``README.org`` for npmjs.com, which only
## renders Markdown, and appends the changelog to it: the README is the
## only document npmjs.com displays for a package.
##
## npmjs.com shows YAML front-matter verbatim, so ``#+TITLE`` becomes
## the only level-1 heading, with org sections and the changelog one
## level below it.
##
## Needs ``pandoc`` and ``gitchangelog``.  Without them this step is
## skipped with a warning (a fresh clone can still build); the release
## pipeline sets ``AUTOGEN_STRICT=1`` which makes them mandatory.
##

## Shift ATX headings, but not examples inside backtick/tilde fences.
org_to_md_shift_changelog() {
    awk '
    {
      text = $0
      sub(/^   |^  |^ /, "", text)
      if (text ~ /^```+/ || text ~ /^~~~+/) {
        char = substr(text, 1, 1)
        run = text
        if (char == "`") sub(/[^`].*$/, "", run)
        else sub(/[^~].*$/, "", run)
        if (!fence) { fence = char; width = length(run) }
        else if (char == fence && length(run) >= width &&
                 substr(text, length(run) + 1) ~ /^[[:space:]]*$/) fence = ""
        print
        next
      }
      if (!fence && $0 ~ /^[ ]?[ ]?[ ]?#+([[:space:]]|$)/)
        sub(/#/, "##")
      print
    }' "$1"
}

## Appends ``$1`` (a markdown changelog) to ``README.md.tmp``.
org_to_md_append_changelog() {
    echo "" >> README.md.tmp
    echo "" >> README.md.tmp
    if [ -n "$title" ]; then
        org_to_md_shift_changelog "$1" >> README.md.tmp
    else
        cat "$1" >> README.md.tmp
    fi
}

if [ -f README.org ]; then
    depends_soft pandoc || {
        echo "README.md not regenerated (fine for building, required for release)." >&2
        return 0
    }
    title=$(sed -n 's/^#+[Tt][Ii][Tt][Ll][Ee]:[[:space:]]*//p' README.org | head -n 1)
    {
        if [ -n "$title" ]; then
            printf '# %s\n\n' "$title"
            pandoc README.org -f org -t gfm --shift-heading-level-by=1
        else
            pandoc README.org -f org -t gfm
        fi
    } > README.md.tmp || {
        rm -f README.md.tmp
        return 1
    }

    if depends_soft gitchangelog; then
        if [ ! -e .gitchangelog.rc ]; then
            echo "No .gitchangelog.rc found: changelog not appended to README.md." >&2
        else
            changelog_tmp=$(mktemp) || return 1
            gitchangelog > "$changelog_tmp" || {
                rm -f "$changelog_tmp" README.md.tmp
                return 1
            }
            org_to_md_append_changelog "$changelog_tmp"
            rm -f "$changelog_tmp"
        fi
    elif [ -f CHANGELOG.md ]; then
        org_to_md_append_changelog CHANGELOG.md
    fi

    if [ -f README.md ] && diff README.md README.md.tmp > /dev/null; then
        echo "No changes in README.md" >&2
        rm README.md.tmp
    else
        echo "Updating README.md" >&2
        mv README.md.tmp README.md
    fi
fi
