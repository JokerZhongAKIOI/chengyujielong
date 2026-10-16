# -*- coding: utf-8 -*-
"""
生成测试用的 PDF：
  plain.pdf   正常题面：公式是真正的文字（文字层里有 ≤、n、10^5 等）→ 不该检测出公式洞
  vector.pdf  公式被转成了矢量轮廓（文字层里只剩空格）→ 应该检测出公式洞
  scan.pdf    整页一张图片（扫描件）→ 走视觉模型整页识别那条路
跑法：python3 tools/make_fixtures.py
"""
import os

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
FONT = 'STSong-Light'


def header(c, title):
    c.setFont(FONT, 16)
    c.drawString(60, 780, title)
    c.setFont(FONT, 10.5)
    c.drawString(60, 760, '题目描述')
    c.drawString(60, 740, '对于 100% 的数据，保证 1 ≤ n ≤ 10^5，0 < p_i ≤ 1。')
    c.drawString(60, 720, '输出一个小数，你的答案误差不超过 10^-6 就算对。')
    c.drawString(60, 700, '样例输入')
    c.setFont('Courier', 9.5)
    c.drawString(60, 685, '7')
    c.drawString(60, 672, '0.5 0.5 0 0 0 0 0')
    # 表格（有表格线，用来确认表格线不会被当成公式）
    c.setFont(FONT, 10.5)
    c.drawString(60, 650, '下表是各天的情况：')
    c.rect(60, 600, 300, 40, stroke=1, fill=0)
    c.line(60, 620, 360, 620)
    c.line(200, 600, 200, 640)
    c.drawString(66, 626, '天数')
    c.drawString(206, 626, '参与救援的葫芦娃')
    c.drawString(66, 606, '1')
    c.drawString(206, 606, '1 号')
    # 列表（项目符号）
    c.drawString(60, 580, '• 第一天：等待')
    c.drawString(60, 562, '• 第二天：出发')


def make_plain(path):
    c = canvas.Canvas(path, pagesize=A4)
    header(c, 'P2196 葫芦娃救爷爷（正常文字层）')

    def para(y, parts):
        """parts: [(文字, 是否数学字体)]，数学部分用 Symbol + Times-Italic 画，文字层里是真正的字符。"""
        x = 60
        for text, math in parts:
            if math:
                c.setFont('Times-Italic', 10.5)
            else:
                c.setFont(FONT, 10.5)
            c.drawString(x, y, text)
            x += pdfmetrics.stringWidth(text, 'Times-Italic' if math else FONT, 10.5)

    para(520, [('有 ', False), ('n', True), (' 个葫芦娃，第 ', False), ('i', True), (' 个葫芦娃的战斗力是 ', False), ('p', True), ('i', True), ('。', False)])
    para(500, [('第 ', False), ('i', True), (' 天晚上，如果这些葫芦娃的实力总和为 ', False), ('s', True), ('，那么有 ', False), ('p', True), ('i', True), (' 的概率救出爷爷。', False)])
    para(480, [('妖精会首先随机在 ', False), ('1', True), (' 到 ', False), ('n', True), (' 里均匀生成一个正整数 ', False), ('k', True), ('。', False)])
    c.showPage()
    c.save()


def make_vector(path):
    """公式用矢量轮廓画（这里用曲线拼几个“字形”），文字层里只留空格。"""
    c = canvas.Canvas(path, pagesize=A4)
    header(c, 'P2198 矢量公式（公式是图形，文字层里没有）')

    def blob(x, y, w=7, h=9):
        """画一个像字形的封闭轮廓。"""
        p = c.beginPath()
        p.moveTo(x, y)
        p.curveTo(x + w * 0.2, y + h * 0.9, x + w * 0.8, y + h * 1.1, x + w, y + h)
        p.curveTo(x + w * 1.2, y + h * 0.4, x + w * 0.8, y - h * 0.2, x + w * 0.3, y)
        p.close()
        c.drawPath(p, stroke=0, fill=1)

    def para(y, parts):
        """parts: [(文字, 洞的宽度)]，洞宽 > 0 表示这里有个矢量公式。"""
        x = 60
        c.setFont(FONT, 10.5)
        for text, hole in parts:
            c.drawString(x, y, text)
            x += pdfmetrics.stringWidth(text, FONT, 10.5)
            if hole:
                blob(x + 1, y, hole - 4, 9)
                x += hole

    para(520, [('有 ', 12), (' 个葫芦娃，第 ', 10), (' 个葫芦娃的战斗力是 ', 22), ('。', 0)])
    para(500, [('第 ', 10), (' 天晚上，如果这些葫芦娃的实力总和为 ', 14), ('，那么有 ', 14), (' 的概率救出爷爷。', 0)])
    para(480, [('妖精会首先随机在 ', 12), (' 到 ', 12), (' 里均匀生成一个正整数 ', 10), ('。', 0)])
    para(460, [('这一段没有任何公式，只是一句普通的话。', 0)])
    para(440, [('这句话里有一个普通的英文括号 (a) 和数字 12345，没有公式。', 0)])
    c.showPage()
    c.save()


def make_scan(path):
    """整页一张图：模拟扫描件。"""
    from reportlab.lib.utils import ImageReader
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (1240, 1754), 'white')
    d = ImageDraw.Draw(img)
    d.rectangle([80, 80, 1160, 200], outline='black')
    for i in range(12):
        d.line([100, 320 + i * 60, 1100, 320 + i * 60], fill='black', width=4)
    img.save('/tmp/scan_page.png')
    c = canvas.Canvas(path, pagesize=A4)
    c.drawImage(ImageReader('/tmp/scan_page.png'), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()


make_plain(os.path.join(OUT, 'plain-text-math.pdf'))
make_vector(os.path.join(OUT, 'vector-math.pdf'))
make_scan(os.path.join(OUT, 'scan.pdf'))
print('fixtures →', OUT)
