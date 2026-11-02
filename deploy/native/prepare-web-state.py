#!/usr/bin/env python3
# Managed by chunmo native staging deploy
"""Repair only managed nginx temporary paths; no files are removed or followed through symlinks."""
import os
import pathlib
import pwd
import sys


def prepare(base, uid, gid):
    base = pathlib.Path(base)
    if not base.is_absolute() or any(p.is_symlink() for p in [base, *base.parents]):
        raise ValueError('Refusing a symlinked/relative nginx state path')
    base.mkdir(exist_ok=True, parents=True)
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    def repair(fd):
        import stat
        mode = os.fstat(fd)
        if stat.S_ISDIR(mode.st_mode):
            for entry in os.listdir(fd):
                # Resolve relative to the held directory, never through a mutable path.
                child = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    repair(child)
                finally:
                    os.close(child)
            os.fchmod(fd, 0o700)
        elif stat.S_ISREG(mode.st_mode) and mode.st_nlink == 1:
            os.fchmod(fd, 0o600)
        else:
            raise ValueError('Unexpected object in nginx temporary directory')
        os.fchown(fd, uid, gid)
    parent = os.open(base, directory)
    try:
        for name in ('body', 'proxy', 'fastcgi', 'scgi', 'uwsgi'):
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
            child = os.open(name, directory, dir_fd=parent)
            try:
                repair(child)
            finally:
                os.close(child)
        os.fchown(parent, uid, gid)
        os.fchmod(parent, 0o700)
    finally:
        os.close(parent)


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('No path override allowed')
    account = pwd.getpwnam('chunmo-staging-web')
    prepare('/var/lib/chunmo-staging-web', account.pw_uid, account.pw_gid)
