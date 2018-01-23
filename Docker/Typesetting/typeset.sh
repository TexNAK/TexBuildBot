#!/usr/bin/env bash
cd /data
cd $(dirname "${1}")
latexmk -f -pdf -xelatex -r "/glossaries.latexmk" -shell-escape -interaction=nonstopmode -halt-on-error "$(basename ${1})"
