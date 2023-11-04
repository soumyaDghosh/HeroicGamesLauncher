FROM archlinux:latest

RUN pacman -Syyu --noconfirm && pacman -S nodejs npm pnpm --noconfirm
