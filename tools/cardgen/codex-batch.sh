#!/bin/zsh
# Generate card art through the Codex CLI's built-in image tool (the user's own ChatGPT login) — used while OpenRouter's
# image models are region-blocked here. Usage: codex-batch.sh <pack-dir>...   Output: out/cards/<pack-name>.png
C=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
HERE=${0:A:h}; mkdir -p $HERE/out/cards
for d in "$@"; do
  name=${d:t}; id=$(ls $d/1-identity.* | head -1); touch $HERE/out/cards/$name.log.start
  { echo "Use your built-in image generation tool to create exactly ONE image from the brief below. The attached image is the identity reference. Do not write code, run commands or create files; just generate the image once."; echo; tail -n +3 $d/prompt.txt; } \
    | $C exec -s read-only --skip-git-repo-check -i $id - > $HERE/out/cards/$name.log 2>&1
  f=$(ls -t ~/.codex/generated_images/*/exec-*.png 2>/dev/null | head -1)
  if [[ -n $f && $f -nt $HERE/out/cards/$name.log.start ]]; then cp $f $HERE/out/cards/$name.png; echo "✓ $name"; else echo "✗ $name (see $name.log)"; fi
done
